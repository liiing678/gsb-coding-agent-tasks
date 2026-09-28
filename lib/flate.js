// DEFLATE 解压内核：stored / 固定霍夫曼 / 动态霍夫曼三种块，外加 zlib 包装与 Adler-32 校验。
// 口径见 README 的《口径》和《API》两节。

import { FlateError } from './errors.js';

const fail = (code, message, details) => {
  throw new FlateError(code, message, details);
};

const assertBytes = (input) => {
  if (!(input instanceof Uint8Array)) {
    fail('ERR_BAD_INPUT', '入参必须是 Uint8Array');
  }
};

// 长度码 257..285 的基数与附加位（286 / 287 非法，在解出时拦）。
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];

// 距离码 0..29 的基数与附加位（30 / 31 非法）。
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

// 动态块里 19 个码长表码长的摆放顺序。
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// 位流是低字节序：普通字段低位在前。
class BitReader {
  constructor(bytes, bytePos = 0) {
    this.bytes = bytes;
    this.bytePos = bytePos;
    this.bitPos = 0;
  }

  readBit() {
    if (this.bytePos >= this.bytes.length) {
      fail('ERR_TRUNCATED', '位流读到一半输入没了');
    }
    const bit = (this.bytes[this.bytePos] >> this.bitPos) & 1;
    this.bitPos += 1;
    if (this.bitPos === 8) {
      this.bitPos = 0;
      this.bytePos += 1;
    }
    return bit;
  }

  readBits(count) {
    let value = 0;
    for (let i = 0; i < count; i += 1) value |= this.readBit() << i;
    return value;
  }

  alignToByte() {
    if (this.bitPos !== 0) {
      this.bitPos = 0;
      this.bytePos += 1;
    }
  }

  readByte() {
    if (this.bytePos >= this.bytes.length) {
      fail('ERR_TRUNCATED', '字节流读到一半输入没了');
    }
    const byte = this.bytes[this.bytePos];
    this.bytePos += 1;
    return byte;
  }

  // 已经消耗掉的字节数（不足一个字节的位算一个字节）。
  consumed() {
    return this.bytePos + (this.bitPos > 0 ? 1 : 0);
  }
}

// 由码长表建霍夫曼解码表。超订一律非法；不完整只允许整张表恰好一个码；
// 全 0 返回空表（距离表允许，真去解时才报错）。
const buildTable = (lengths) => {
  let maxLen = 0;
  let total = 0;
  for (const length of lengths) {
    if (length > maxLen) maxLen = length;
    if (length > 0) total += 1;
  }
  if (total === 0) return { maxLen: 0, map: null };

  const counts = new Array(maxLen + 1).fill(0);
  for (const length of lengths) if (length > 0) counts[length] += 1;

  let left = 1;
  for (let len = 1; len <= maxLen; len += 1) {
    left = (left << 1) - counts[len];
    if (left < 0) fail('ERR_BAD_HUFFMAN', '码表超订');
  }
  if (left > 0 && total !== 1) fail('ERR_BAD_HUFFMAN', '码表不完整');

  const next = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let len = 1; len <= maxLen; len += 1) {
    code = (code + counts[len - 1]) << 1;
    next[len] = code;
  }
  const map = new Map();
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol];
    if (length > 0) {
      map.set((length << 16) | next[length], symbol);
      next[length] += 1;
    }
  }
  return { maxLen, map };
};

// 霍夫曼码字高位在前：从最高位开始一位一位往树里走。
const decodeSymbol = (reader, table) => {
  if (table.map === null) fail('ERR_BAD_HUFFMAN', '空码表不能解码');
  let code = 0;
  for (let len = 1; len <= table.maxLen; len += 1) {
    code = (code << 1) | reader.readBit();
    const symbol = table.map.get((len << 16) | code);
    if (symbol !== undefined) return symbol;
  }
  fail('ERR_BAD_HUFFMAN', '码字不在表里');
};

// 输出缓冲：返回值必须是新 Uint8Array，不能把内部缓冲交出去。
class OutBuf {
  constructor() {
    this.buf = new Uint8Array(4096);
    this.len = 0;
  }

  grow(need) {
    let cap = this.buf.length;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  push(byte) {
    if (this.len === this.buf.length) this.grow(this.len + 1);
    this.buf[this.len] = byte;
    this.len += 1;
  }

  pushBytes(bytes) {
    if (this.len + bytes.length > this.buf.length) this.grow(this.len + bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  finish() {
    return this.buf.slice(0, this.len);
  }
}

const inflateStored = (reader, out) => {
  reader.alignToByte();
  if (reader.bytePos + 4 > reader.bytes.length) {
    fail('ERR_TRUNCATED', 'stored 块的 LEN / NLEN 不完整');
  }
  const len = reader.readByte() | (reader.readByte() << 8);
  const nlen = reader.readByte() | (reader.readByte() << 8);
  if ((len ^ 0xffff) !== nlen) {
    fail('ERR_BAD_LENGTH', 'stored 块的 LEN 与 NLEN 对不上');
  }
  if (reader.bytePos + len > reader.bytes.length) {
    fail('ERR_TRUNCATED', 'stored 块的数据不够');
  }
  out.pushBytes(reader.bytes.subarray(reader.bytePos, reader.bytePos + len));
  reader.bytePos += len;
};

const inflateCompressed = (reader, out, litTable, distTable) => {
  for (;;) {
    const symbol = decodeSymbol(reader, litTable);
    if (symbol === 256) return;
    if (symbol < 256) {
      out.push(symbol);
      continue;
    }
    if (symbol > 285) fail('ERR_BAD_LENGTH', `非法长度码 ${symbol}`);
    const li = symbol - 257;
    const length = LENGTH_BASE[li] + reader.readBits(LENGTH_EXTRA[li]);
    const distSymbol = decodeSymbol(reader, distTable);
    if (distSymbol > 29) fail('ERR_BAD_DISTANCE', `非法距离码 ${distSymbol}`);
    const dist = DIST_BASE[distSymbol] + reader.readBits(DIST_EXTRA[distSymbol]);
    if (dist > out.len) fail('ERR_BAD_DISTANCE', '距离超过已解出的字节数');
    // 距离可以小于长度（重叠复制），必须一个字节一个字节往回抄。
    for (let i = 0; i < length; i += 1) out.push(out.buf[out.len - dist]);
  }
};

const readDynamicTables = (reader) => {
  const hlit = reader.readBits(5) + 257;
  const hdist = reader.readBits(5) + 1;
  const hclen = reader.readBits(4) + 4;
  const clenLengths = new Array(19).fill(0);
  for (let i = 0; i < hclen; i += 1) clenLengths[CLEN_ORDER[i]] = reader.readBits(3);
  const clenTable = buildTable(clenLengths);

  const total = hlit + hdist;
  const lengths = new Array(total).fill(0);
  let index = 0;
  while (index < total) {
    const symbol = decodeSymbol(reader, clenTable);
    if (symbol < 16) {
      lengths[index] = symbol;
      index += 1;
    } else if (symbol === 16) {
      if (index === 0) fail('ERR_BAD_LENGTH', '码长 16 前面没有可复制的码长');
      const repeat = 3 + reader.readBits(2);
      if (index + repeat > total) fail('ERR_BAD_LENGTH', '码长重复次数越界');
      lengths.fill(lengths[index - 1], index, index + repeat);
      index += repeat;
    } else {
      const repeat = (symbol === 17 ? 3 : 11) + reader.readBits(symbol === 17 ? 3 : 7);
      if (index + repeat > total) fail('ERR_BAD_LENGTH', '码长重复次数越界');
      index += repeat; // 这一段本来就是 0
    }
  }

  const litLengths = lengths.slice(0, hlit);
  const distLengths = lengths.slice(hlit);
  if (litLengths[256] === 0) fail('ERR_BAD_HUFFMAN', '字面/长度表里没有块结束符 256');
  return [buildTable(litLengths), buildTable(distLengths)];
};

const FIXED_LIT_TABLE = (() => {
  const lengths = new Array(288).fill(8);
  for (let symbol = 144; symbol <= 255; symbol += 1) lengths[symbol] = 9;
  for (let symbol = 256; symbol <= 279; symbol += 1) lengths[symbol] = 7;
  return buildTable(lengths);
})();
const FIXED_DIST_TABLE = buildTable(new Array(32).fill(5));

// 从 bytePos 开始解一串块，返回解出的字节和 DEFLATE 数据结束的位置。
const inflate = (bytes, bytePos) => {
  const reader = new BitReader(bytes, bytePos);
  const out = new OutBuf();
  for (;;) {
    const bfinal = reader.readBits(1);
    const btype = reader.readBits(2);
    if (btype === 0) {
      inflateStored(reader, out);
    } else if (btype === 1) {
      inflateCompressed(reader, out, FIXED_LIT_TABLE, FIXED_DIST_TABLE);
    } else if (btype === 2) {
      const [litTable, distTable] = readDynamicTables(reader);
      inflateCompressed(reader, out, litTable, distTable);
    } else {
      fail('ERR_BAD_BLOCK', 'BTYPE = 3 是保留值');
    }
    if (bfinal === 1) break;
  }
  return { data: out.finish(), end: reader.consumed() };
};

export function inflateRaw(input) {
  assertBytes(input);
  // raw 流在最后一个块结束后就算完，后面有没有多余字节都不看。
  return inflate(input, 0).data;
}

export function inflateZlib(input) {
  assertBytes(input);
  if (input.length < 2) fail('ERR_BAD_ZLIB', 'zlib 头不够 2 个字节');
  const cmf = input[0];
  const flg = input[1];
  if ((cmf & 0x0f) !== 8) fail('ERR_BAD_ZLIB', 'CM 不是 8（deflate）');
  if ((cmf >> 4) > 7) fail('ERR_BAD_ZLIB', 'CINFO 大于 7');
  if (((cmf << 8) | flg) % 31 !== 0) fail('ERR_BAD_ZLIB', 'FCHECK 校验不通过');
  if ((flg & 0x20) !== 0) fail('ERR_BAD_ZLIB', '不支持 FDICT');

  const { data, end } = inflate(input, 2);
  const remaining = input.length - end;
  if (remaining < 4) fail('ERR_TRUNCATED', 'zlib 尾部的 Adler-32 不完整');
  if (remaining > 4) fail('ERR_BAD_ZLIB', 'DEFLATE 数据后面还有多余字节');
  const expected = (
    ((input[end] << 24) | (input[end + 1] << 16) | (input[end + 2] << 8) | input[end + 3]) >>> 0
  );
  if (adler32(data) !== expected) fail('ERR_CHECKSUM', 'Adler-32 校验值对不上');
  return data;
}

export function adler32(input, seed = 1) {
  assertBytes(input);
  const MOD = 65521;
  let a = seed & 0xffff;
  let b = (seed >>> 16) & 0xffff;
  let index = 0;
  while (index < input.length) {
    // 5552 是取模前不会溢出 32 位的最大块长。
    const stop = Math.min(index + 5552, input.length);
    for (; index < stop; index += 1) {
      a += input[index];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}
