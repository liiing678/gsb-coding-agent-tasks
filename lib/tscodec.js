// 时序压缩内核：把 [{ t, v }] 编成字节、再解回来。
//
// 字节口径见 README 的《口径》一节：11 字节头 + 若干块，块内是
// 18 字节块头、delta-of-delta 时间戳段、XOR 值段，最后 4 字节 CRC32。

import { TscodecError } from './errors.js';

const MAGIC = [0x54, 0x53, 0x43, 0x4f]; // 'TSCO'
const VERSION = 1;
const HEADER_BYTES = 11;
const BLOCK_HEADER_BYTES = 18; // 条数(2) + 首条 t(8) + 首条 v(8)
const CRC_BYTES = 4;
const DEFAULT_BLOCK_SIZE = 120;
const MAX_BLOCK_SIZE = 65535;

const fail = (code, message, details) => {
  throw new TscodecError(code, message, details);
};

// ---- CRC32（IEEE：多项式 0xEDB88320 反射、初值 0xFFFFFFFF、末态取反）----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes, start, end) => {
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

// ---- 双精度 <-> 64 位 ----

const f64Buffer = new ArrayBuffer(8);
const f64View = new DataView(f64Buffer);

const doubleToBits = (v) => {
  f64View.setFloat64(0, v, false);
  return f64View.getBigUint64(0, false);
};

const bitsToDouble = (bits) => {
  f64View.setBigUint64(0, bits, false);
  return f64View.getFloat64(0, false);
};

// ---- 64 位前导零 / 尾部零 ----

const clz64 = (x) => {
  let n = 0;
  for (let bit = 63; bit >= 0; bit -= 1) {
    if ((x >> BigInt(bit)) & 1n) break;
    n += 1;
  }
  return n;
};

const tz64 = (x) => {
  let n = 0;
  while (n < 64 && !((x >> BigInt(n)) & 1n)) n += 1;
  return n;
};

// ---- zigzag + LEB128 ----

const zigzagEncode = (dod) => (dod >= 0n ? 2n * dod : -2n * dod - 1n);

const zigzagDecode = (zz) => (zz & 1n ? -((zz + 1n) / 2n) : zz / 2n);

const writeVarint = (out, value) => {
  let rest = value;
  for (;;) {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest !== 0n) byte |= 0x80;
    out.push(byte);
    if (rest === 0n) return;
  }
};

// ---- 编码 ----

const validatePoints = (points) => {
  if (!Array.isArray(points)) {
    fail('ERR_BAD_INPUT', 'points 必须是数组');
  }
  let prevT = null;
  for (const point of points) {
    if (point === null || typeof point !== 'object') {
      fail('ERR_BAD_INPUT', '每个点必须是 { t, v }');
    }
    const { t, v } = point;
    if (!Number.isSafeInteger(t)) {
      fail('ERR_BAD_INPUT', 't 必须是安全整数');
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      fail('ERR_BAD_INPUT', 'v 必须是有限数');
    }
    if (prevT !== null && t <= prevT) {
      fail('ERR_BAD_INPUT', 't 必须严格递增');
    }
    prevT = t;
  }
};

const resolveBlockSize = (options) => {
  const blockSize = options && options.blockSize !== undefined
    ? options.blockSize
    : DEFAULT_BLOCK_SIZE;
  if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > MAX_BLOCK_SIZE) {
    fail('ERR_BAD_OPTIONS', 'blockSize 必须是 1..65535 的整数');
  }
  return blockSize;
};

const pushU16 = (out, value) => {
  out.push((value >>> 8) & 0xff, value & 0xff);
};

const pushU32 = (out, value) => {
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
};

const pushI64 = (out, value) => {
  const unsigned = BigInt.asUintN(64, value);
  for (let shift = 56; shift >= 0; shift -= 8) {
    out.push(Number((unsigned >> BigInt(shift)) & 0xffn));
  }
};

const pushF64 = (out, value) => {
  f64View.setFloat64(0, value, false);
  for (let i = 0; i < 8; i += 1) out.push(f64View.getUint8(i));
};

// 值段：与块内上一条的 64 位表示异或，0 就一个字节，否则只写有效位。
const pushValue = (out, bits, prevBits) => {
  const xor = bits ^ prevBits;
  if (xor === 0n) {
    out.push(0x00);
    return;
  }
  const leading = clz64(xor);
  const trailing = tz64(xor);
  const significant = 64 - leading - trailing;
  const significand = xor >> BigInt(trailing);
  const byteCount = Math.ceil(significant / 8);
  out.push(0x01, leading, significant - 1);
  for (let i = byteCount - 1; i >= 0; i -= 1) {
    out.push(Number((significand >> BigInt(i * 8)) & 0xffn));
  }
};

export function encodeSeries(points, options) {
  validatePoints(points);
  const blockSize = resolveBlockSize(options);

  const out = [];
  out.push(...MAGIC, VERSION);
  pushU16(out, blockSize);
  pushU32(out, points.length);

  for (let blockStart = 0; blockStart < points.length; blockStart += blockSize) {
    const block = points.slice(blockStart, blockStart + blockSize);
    const blockBytes = [];

    pushU16(blockBytes, block.length);
    pushI64(blockBytes, BigInt(block[0].t));
    pushF64(blockBytes, block[0].v);

    // 时间戳段：delta-of-delta，块内第二条的上一个 delta 当成 0。
    let prevT = BigInt(block[0].t);
    let prevDelta = 0n;
    for (const { t } of block.slice(1)) {
      const current = BigInt(t);
      const delta = current - prevT;
      writeVarint(blockBytes, zigzagEncode(delta - prevDelta));
      prevDelta = delta;
      prevT = current;
    }

    // 值段：块内第一条的 v 在块头里，异或链从它开始。
    let prevBits = doubleToBits(block[0].v);
    for (const { v } of block.slice(1)) {
      const bits = doubleToBits(v);
      pushValue(blockBytes, bits, prevBits);
      prevBits = bits;
    }

    out.push(...blockBytes);
    pushU32(out, crc32(blockBytes, 0, blockBytes.length));
  }

  return Uint8Array.from(out);
}

// ---- 解码 ----

const readU16 = (bytes, offset) => (bytes[offset] << 8) | bytes[offset + 1];

const readU32 = (bytes, offset) => (
  ((bytes[offset] << 24) | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
);

const readI64 = (bytes, offset) => {
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    value = (value << 8n) | BigInt(bytes[offset + i]);
  }
  return BigInt.asIntN(64, value);
};

const readF64 = (bytes, offset) => {
  for (let i = 0; i < 8; i += 1) f64View.setUint8(i, bytes[offset + i]);
  return f64View.getFloat64(0, false);
};

// 头、每块条数、条数总和、每块 CRC 全部核一遍，错一处就抛对应的码。
const parse = (bytes) => {
  if (!(bytes instanceof Uint8Array)) {
    fail('ERR_BAD_INPUT', '输入必须是 Uint8Array');
  }
  if (bytes.length < HEADER_BYTES) {
    fail('ERR_TRUNCATED', '字节不够读完头');
  }
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (bytes[i] !== MAGIC[i]) fail('ERR_BAD_HEADER', 'magic 不对');
  }
  if (bytes[4] !== VERSION) fail('ERR_BAD_HEADER', '版本不对');
  const blockSize = readU16(bytes, 5);
  if (blockSize === 0) fail('ERR_BAD_HEADER', 'blockSize 不能是 0');
  const total = readU32(bytes, 7);

  const points = [];
  let blocks = 0;
  let timestampBytes = 0;
  let valueBytes = 0;
  let offset = HEADER_BYTES;

  while (points.length < total) {
    if (offset + 2 > bytes.length) fail('ERR_TRUNCATED', '字节不够读完块条数');
    const count = readU16(bytes, offset);
    if (count < 1 || count > blockSize) {
      fail('ERR_BAD_HEADER', '块条数不在 1..blockSize 里');
    }
    if (offset + BLOCK_HEADER_BYTES > bytes.length) {
      fail('ERR_TRUNCATED', '字节不够读完块头');
    }
    const blockStart = offset;
    offset += 2;

    let prevT = readI64(bytes, offset);
    offset += 8;
    let prevBits = doubleToBits(readF64(bytes, offset));
    offset += 8;
    points.push({ t: Number(prevT), v: bitsToDouble(prevBits) });

    // 时间戳段
    let prevDelta = 0n;
    for (let k = 1; k < count; k += 1) {
      let zz = 0n;
      let shift = 0n;
      for (;;) {
        if (offset >= bytes.length) fail('ERR_TRUNCATED', '字节不够读完变长整数');
        const byte = bytes[offset];
        offset += 1;
        timestampBytes += 1;
        zz |= BigInt(byte & 0x7f) << shift;
        if (!(byte & 0x80)) break;
        shift += 7n;
      }
      const delta = prevDelta + zigzagDecode(zz);
      prevT += delta;
      prevDelta = delta;
      points.push({ t: Number(prevT), v: 0 });
    }

    // 值段
    for (let k = 1; k < count; k += 1) {
      if (offset >= bytes.length) fail('ERR_TRUNCATED', '字节不够读完值段');
      const tag = bytes[offset];
      offset += 1;
      valueBytes += 1;
      if (tag === 0x00) {
        points[points.length - count + k].v = bitsToDouble(prevBits);
        continue;
      }
      if (tag !== 0x01) fail('ERR_BAD_HEADER', '值的标记字节不认得');
      if (offset + 2 > bytes.length) fail('ERR_TRUNCATED', '字节不够读完值段');
      const leading = bytes[offset];
      const significant = bytes[offset + 1] + 1;
      offset += 2;
      valueBytes += 2;
      if (leading + significant > 64) {
        fail('ERR_BAD_HEADER', '值段的前导零与有效位数对不上');
      }
      const byteCount = Math.ceil(significant / 8);
      if (offset + byteCount > bytes.length) {
        fail('ERR_TRUNCATED', '字节不够读完值段');
      }
      let significand = 0n;
      for (let i = 0; i < byteCount; i += 1) {
        significand = (significand << 8n) | BigInt(bytes[offset + i]);
      }
      offset += byteCount;
      valueBytes += byteCount;
      const trailing = 64 - leading - significant;
      prevBits ^= significand << BigInt(trailing);
      points[points.length - count + k].v = bitsToDouble(prevBits);
    }

    if (offset + CRC_BYTES > bytes.length) fail('ERR_TRUNCATED', '字节不够读完 CRC');
    const expected = readU32(bytes, offset);
    if (crc32(bytes, blockStart, offset) !== expected) {
      fail('ERR_CHECKSUM', '块 CRC 对不上');
    }
    offset += CRC_BYTES;
    blocks += 1;
  }

  if (points.length !== total) {
    fail('ERR_BAD_HEADER', '条数总和跟头里对不上');
  }
  if (offset !== bytes.length) {
    fail('ERR_BAD_HEADER', '尾部有多余字节');
  }

  return { points, blocks, timestampBytes, valueBytes };
};

export function decodeSeries(bytes) {
  const { points, blocks } = parse(bytes);
  return { points, blocks };
}

export function stats(bytes) {
  const { points, blocks, timestampBytes, valueBytes } = parse(bytes);
  return {
    points: points.length,
    blocks,
    bytes: bytes.length,
    headerBytes: HEADER_BYTES,
    timestampBytes,
    valueBytes,
    overheadBytes: blocks * (BLOCK_HEADER_BYTES + CRC_BYTES),
  };
}
