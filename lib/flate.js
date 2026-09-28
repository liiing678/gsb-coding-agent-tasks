// DEFLATE 解压内核：stored / 固定霍夫曼 / 动态霍夫曼三种块，外加 zlib 包装与 Adler-32 校验。
// 口径见 README 的《口径》和《API》两节。

import { FlateError } from './errors.js';

const MAX_BITS = 15;

const fail = (code, message, details) => {
  throw new FlateError(code, message, details);
};

const assertBytes = (input) => {
  if (!(input instanceof Uint8Array)) {
    fail('ERR_BAD_INPUT', '入参必须是 Uint8Array', { received: input });
  }
};

// 长度码 257..285 的基数与附加位。
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];

// 距离码 0..29 的基数与附加位。
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

// 动态块里 19 个码长表项的固定排列顺序。
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// 位流是低字节序：普通字段低位在前，先读到的是最低有效位。
class BitReader {
  constructor(bytes, offset = 0) {
    this.bytes = bytes;
    this.pos = offset;
    this.bit = 0;
  }

  readBit() {
    if (this.pos >= this.bytes.length) {
      fail('ERR_TRUNCATED', '位流读到一半输入没了');
    }
    const value = (this.bytes[this.pos] >> this.bit) & 1;
    this.bit += 1;
    if (this.bit === 8) {
      this.bit = 0;
      this.pos += 1;
    }
    return value;
  }

  readBits(count) {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      value |= this.readBit() << i;
    }
    return value;
  }

  align() {
    if (this.bit !== 0) {
      this.bit = 0;
      this.pos += 1;
    }
  }

  readByte() {
    if (this.pos >= this.bytes.length) {
      fail('ERR_TRUNCATED', '字节流读到一半输入没了');
    }
    const value = this.bytes[this.pos];
    this.pos += 1;
    return value;
  }

  consumed() {
    return this.pos + (this.bit !== 0 ? 1 : 0);
  }
}

// 由码长表构建 canonical 霍夫曼表。超订一律非法；不完整只允许整张表恰好一个码；
// allowEmpty 时（距离表）允许整张表都是 0，真去解的时候才报错。
const buildTable = (lengths, { allowEmpty = false } = {}) => {
  const counts = new Array(MAX_BITS + 1).fill(0);
  let total = 0;
  let maxLen = 0;
  for (const length of lengths) {
    if (length > 0) {
      if (length > MAX_BITS) fail('ERR_BAD_HUFFMAN', '码长超过 15 位');
      counts[length] += 1;
      total += 1;
      if (length > maxLen) maxLen = length;
    }
  }
  if (total === 0) {
    if (!allowEmpty) fail('ERR_BAD_HUFFMAN', '码表是空的');
    return { counts, symbols: [], maxLen: 0 };
  }
  let left = 1;
  for (let len = 1; len <= MAX_BITS; len += 1) {
    left <<= 1;
    left -= counts[len];
    if (left < 0) fail('ERR_BAD_HUFFMAN', '码表超订');
  }
  if (left > 0 && total !== 1) fail('ERR_BAD_HUFFMAN', '码表不完整');

  const offsets = new Array(MAX_BITS + 1).fill(0);
  for (let len = 1; len < MAX_BITS; len += 1) {
    offsets[len + 1] = offsets[len] + counts[len];
  }
  const symbols = new Array(total).fill(0);
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol];
    if (length > 0) {
      symbols[offsets[length]] = symbol;
      offsets[length] += 1;
    }
  }
  return { counts, symbols, maxLen };
};

// 霍夫曼码字高位在前：从最高位开始一位一位往树里走。
const decodeSymbol = (reader, table) => {
  const { counts, symbols, maxLen } = table;
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= maxLen; len += 1) {
    code = (code << 1) | reader.readBit();
    const count = counts[len];
    if (code - first < count) return symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
  }
  fail('ERR_BAD_HUFFMAN', '码字不在表里');
};

const FIXED_LIT_LENGTHS = (() => {
  const lengths = new Array(288).fill(8);
  for (let symbol = 144; symbol <= 255; symbol += 1) lengths[symbol] = 9;
  for (let symbol = 256; symbol <= 279; symbol += 1) lengths[symbol] = 7;
  return lengths;
})();
const FIXED_DIST_LENGTHS = new Array(32).fill(5);
const FIXED_LIT_TABLE = buildTable(FIXED_LIT_LENGTHS);
const FIXED_DIST_TABLE = buildTable(FIXED_DIST_LENGTHS);

const inflateStored = (reader, out) => {
  reader.align();
  const len = reader.readByte() | (reader.readByte() << 8);
  const nlen = reader.readByte() | (reader.readByte() << 8);
  if ((len ^ 0xffff) !== nlen) {
    fail('ERR_BAD_LENGTH', 'stored 块的 LEN / NLEN 对不上', { len, nlen });
  }
  if (reader.pos + len > reader.bytes.length) {
    fail('ERR_TRUNCATED', 'stored 块的数据不够');
  }
  for (let i = 0; i < len; i += 1) out.push(reader.bytes[reader.pos + i]);
  reader.pos += len;
};

const readDynamicTables = (reader) => {
  const hlit = reader.readBits(5) + 257;
  const hdist = reader.readBits(5) + 1;
  const hclen = reader.readBits(4) + 4;
  const clLengths = new Array(19).fill(0);
  for (let i = 0; i < hclen; i += 1) {
    clLengths[CODE_LENGTH_ORDER[i]] = reader.readBits(3);
  }
  const clTable = buildTable(clLengths, { allowEmpty: true });

  const total = hlit + hdist;
  const lengths = [];
  while (lengths.length < total) {
    const symbol = decodeSymbol(reader, clTable);
    if (symbol < 16) {
      lengths.push(symbol);
    } else {
      let repeat;
      let value;
      if (symbol === 16) {
        if (lengths.length === 0) {
          fail('ERR_BAD_LENGTH', '码长 16 前面没有可复制的码长');
        }
        repeat = 3 + reader.readBits(2);
        value = lengths[lengths.length - 1];
      } else if (symbol === 17) {
        repeat = 3 + reader.readBits(3);
        value = 0;
      } else {
        repeat = 11 + reader.readBits(7);
        value = 0;
      }
      if (lengths.length + repeat > total) {
        fail('ERR_BAD_LENGTH', '码长重复次数越过总数');
      }
      for (let i = 0; i < repeat; i += 1) lengths.push(value);
    }
  }

  const litLengths = lengths.slice(0, hlit);
  if (litLengths[256] === 0) {
    fail('ERR_BAD_HUFFMAN', '字面/长度表里没有块结束符 256');
  }
  return [
    buildTable(litLengths),
    buildTable(lengths.slice(hlit), { allowEmpty: true }),
  ];
};

const inflateCompressed = (reader, out, litTable, distTable) => {
  for (;;) {
    const symbol = decodeSymbol(reader, litTable);
    if (symbol < 256) {
      out.push(symbol);
      continue;
    }
    if (symbol === 256) return;
    if (symbol > 285) fail('ERR_BAD_LENGTH', '长度码 286 / 287 非法', { symbol });
    const li = symbol - 257;
    const length = LENGTH_BASE[li] + reader.readBits(LENGTH_EXTRA[li]);
    const distSymbol = decodeSymbol(reader, distTable);
    if (distSymbol > 29) fail('ERR_BAD_DISTANCE', '距离码 30 / 31 非法', { distSymbol });
    const distance = DIST_BASE[distSymbol] + reader.readBits(DIST_EXTRA[distSymbol]);
    if (distance > out.length) {
      fail('ERR_BAD_DISTANCE', '距离超过已解出的字节数', { distance, available: out.length });
    }
    // 距离小于长度是合法的重叠复制，必须一个字节一个字节往回抄。
    for (let i = 0; i < length; i += 1) out.push(out[out.length - distance]);
  }
};

const inflateBlocks = (reader) => {
  const out = [];
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
    if (bfinal) return Uint8Array.from(out);
  }
};

export function inflateRaw(input) {
  assertBytes(input);
  return inflateBlocks(new BitReader(input));
}

export function inflateZlib(input) {
  assertBytes(input);
  if (input.length < 2) fail('ERR_BAD_ZLIB', 'zlib 头不够 2 个字节');
  const cmf = input[0];
  const flg = input[1];
  if ((cmf & 0x0f) !== 8) fail('ERR_BAD_ZLIB', 'CM 不是 8');
  if ((cmf >> 4) > 7) fail('ERR_BAD_ZLIB', 'CINFO 大于 7');
  if (((cmf << 8) | flg) % 31 !== 0) fail('ERR_BAD_ZLIB', 'FCHECK 校验失败');
  if (flg & 0x20) fail('ERR_BAD_ZLIB', 'FDICT 被置上');

  const reader = new BitReader(input, 2);
  const out = inflateBlocks(reader);
  const rest = input.length - reader.consumed();
  if (rest < 4) fail('ERR_TRUNCATED', 'zlib 尾部的 Adler-32 不完整');
  if (rest > 4) fail('ERR_BAD_ZLIB', 'DEFLATE 数据后面还有多余字节');
  const tail = input.length - 4;
  const expected = ((input[tail] << 24) | (input[tail + 1] << 16)
    | (input[tail + 2] << 8) | input[tail + 3]) >>> 0;
  if (adler32(out) !== expected) fail('ERR_CHECKSUM', 'Adler-32 校验失败');
  return out;
}

export function adler32(input, seed = 1) {
  assertBytes(input);
  let a = seed & 0xffff;
  let b = (seed >>> 16) & 0xffff;
  let index = 0;
  while (index < input.length) {
    const end = Math.min(index + 5552, input.length);
    for (; index < end; index += 1) {
      a += input[index];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
