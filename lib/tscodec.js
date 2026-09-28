// 时序压缩内核：把 [{ t, v }] 编成字节、再解回来。口径见 README 的《口径》和《API》。
import { TscodecError } from './errors.js';

const MAGIC = [0x54, 0x53, 0x43, 0x4F]; // 'TSCO'
const VERSION = 1;
const HEADER_BYTES = 11;
const BLOCK_HEADER_BYTES = 18; // 条数 2 + 第一条 t 8 + 第一条 v 8
const CRC_BYTES = 4;
const DEFAULT_BLOCK_SIZE = 120;
const MAX_BLOCK_SIZE = 65535;

const fail = (code, message, details) => {
  throw new TscodecError(code, message, details);
};

// CRC32（IEEE：多项式 0xEDB88320 反射、初值 0xFFFFFFFF、最后取反），自己算，不借 node:zlib。
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

const crc32 = (bytes, start, end) => {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
};

// 双精度 <-> 64 位位模式，异或链用的是位模式。
const scratch = new DataView(new ArrayBuffer(8));
const bitsOf = (v) => {
  scratch.setFloat64(0, v, false);
  return scratch.getBigUint64(0, false);
};
const floatOf = (bits) => {
  scratch.setBigUint64(0, bits, false);
  return scratch.getFloat64(0, false);
};

const zigzag = (dod) => (dod >= 0n ? 2n * dod : -2n * dod - 1n);
const unzigzag = (z) => (z & 1n ? -((z + 1n) / 2n) : z / 2n);

class Writer {
  constructor() {
    this.bytes = [];
  }

  u8(x) {
    this.bytes.push(x & 0xFF);
  }

  u16(x) {
    this.bytes.push((x >>> 8) & 0xFF, x & 0xFF);
  }

  u32(x) {
    this.bytes.push((x >>> 24) & 0xFF, (x >>> 16) & 0xFF, (x >>> 8) & 0xFF, x & 0xFF);
  }

  i64(x) {
    let v = BigInt.asUintN(64, x);
    for (let i = 7; i >= 0; i -= 1) {
      this.bytes.push(Number((v >> BigInt(i * 8)) & 0xFFn));
    }
  }

  f64(x) {
    this.i64(bitsOf(x));
  }

  varint(x) {
    let v = x;
    for (;;) {
      const b = Number(v & 0x7Fn);
      v >>= 7n;
      if (v === 0n) {
        this.bytes.push(b);
        return;
      }
      this.bytes.push(b | 0x80);
    }
  }
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }

  need(n) {
    if (this.pos + n > this.bytes.length) {
      fail('ERR_TRUNCATED', '字节不够，读不完整', { offset: this.pos, need: n });
    }
  }

  u8() {
    this.need(1);
    const v = this.bytes[this.pos];
    this.pos += 1;
    return v;
  }

  u16() {
    this.need(2);
    const v = this.view.getUint16(this.pos, false);
    this.pos += 2;
    return v;
  }

  u32() {
    this.need(4);
    const v = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return v;
  }

  i64() {
    this.need(8);
    const v = this.view.getBigInt64(this.pos, false);
    this.pos += 8;
    return v;
  }

  u64() {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, false);
    this.pos += 8;
    return v;
  }

  varint() {
    let result = 0n;
    for (let i = 0; i < 10; i += 1) {
      const b = this.u8();
      result |= BigInt(b & 0x7F) << BigInt(7 * i);
      if ((b & 0x80) === 0) return result;
    }
    fail('ERR_BAD_HEADER', '变长整数超过 10 个字节', { offset: this.pos });
    return 0n;
  }
}

const validatePoints = (points) => {
  if (!Array.isArray(points)) {
    fail('ERR_BAD_INPUT', 'points 必须是数组');
  }
  let prevT = null;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    if (p === null || typeof p !== 'object') {
      fail('ERR_BAD_INPUT', `第 ${i} 条不是 { t, v }`, { index: i });
    }
    if (!Number.isSafeInteger(p.t)) {
      fail('ERR_BAD_INPUT', `第 ${i} 条的 t 不是安全整数`, { index: i });
    }
    if (typeof p.v !== 'number' || !Number.isFinite(p.v)) {
      fail('ERR_BAD_INPUT', `第 ${i} 条的 v 不是有限数`, { index: i });
    }
    if (prevT !== null && p.t <= prevT) {
      fail('ERR_BAD_INPUT', `第 ${i} 条的 t 没有严格递增`, { index: i });
    }
    prevT = p.t;
  }
};

const resolveBlockSize = (options) => {
  const blockSize = options?.blockSize ?? DEFAULT_BLOCK_SIZE;
  if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > MAX_BLOCK_SIZE) {
    fail('ERR_BAD_OPTIONS', 'blockSize 必须是 1..65535 的整数', { blockSize });
  }
  return blockSize;
};

// 值段的一条：xor 为 0 写 0x00，否则 0x01 + 前导零个数 + (有效位数 - 1) + 有效位。
const writeValue = (out, xor) => {
  if (xor === 0n) {
    out.u8(0x00);
    return;
  }
  const leading = 64 - xor.toString(2).length;
  const lowest = xor & -xor;
  const trailing = lowest.toString(2).length - 1;
  const significant = 64 - leading - trailing;
  const shifted = xor >> BigInt(trailing);
  const nbytes = (significant + 7) >> 3;
  out.u8(0x01);
  out.u8(leading);
  out.u8(significant - 1);
  for (let i = nbytes - 1; i >= 0; i -= 1) {
    out.u8(Number((shifted >> BigInt(i * 8)) & 0xFFn));
  }
};

const readValue = (reader) => {
  const tag = reader.u8();
  if (tag === 0x00) return 0n;
  if (tag !== 0x01) {
    fail('ERR_BAD_HEADER', '值段的标记字节不认得', { tag });
  }
  const leading = reader.u8();
  const significant = reader.u8() + 1;
  if (leading + significant > 64) {
    fail('ERR_BAD_HEADER', '值段的前导零和有效位数对不上', { leading, significant });
  }
  const trailing = 64 - leading - significant;
  const nbytes = (significant + 7) >> 3;
  reader.need(nbytes);
  let y = 0n;
  for (let i = 0; i < nbytes; i += 1) {
    y = (y << 8n) | BigInt(reader.bytes[reader.pos]);
    reader.pos += 1;
  }
  return y << BigInt(trailing);
};

export function encodeSeries(points, options) {
  validatePoints(points);
  const blockSize = resolveBlockSize(options);

  const out = new Writer();
  for (const b of MAGIC) out.u8(b);
  out.u8(VERSION);
  out.u16(blockSize);
  out.u32(points.length);

  for (let start = 0; start < points.length; start += blockSize) {
    const end = Math.min(start + blockSize, points.length);
    const blockStart = out.bytes.length;
    out.u16(end - start);
    out.i64(BigInt(points[start].t));
    out.f64(points[start].v);

    // 时间戳段：delta 不跨块，每块从 prevDelta = 0 重新算。
    let prevT = BigInt(points[start].t);
    let prevDelta = 0n;
    for (let i = start + 1; i < end; i += 1) {
      const t = BigInt(points[i].t);
      const delta = t - prevT;
      out.varint(zigzag(delta - prevDelta));
      prevDelta = delta;
      prevT = t;
    }

    // 值段：块头里的 v 是异或链的第一环。
    let prevBits = bitsOf(points[start].v);
    for (let i = start + 1; i < end; i += 1) {
      const bits = bitsOf(points[i].v);
      writeValue(out, bits ^ prevBits);
      prevBits = bits;
    }

    out.u32(crc32(out.bytes, blockStart, out.bytes.length));
  }

  return Uint8Array.from(out.bytes);
}

// 解一遍并全部校验：头、每块条数、条数总和、每块 CRC、尾部不多不少。
const parse = (bytes) => {
  if (!(bytes instanceof Uint8Array)) {
    fail('ERR_BAD_INPUT', '输入必须是 Uint8Array');
  }
  const reader = new Reader(bytes);
  reader.need(HEADER_BYTES);
  for (let i = 0; i < 4; i += 1) {
    if (reader.u8() !== MAGIC[i]) fail('ERR_BAD_HEADER', 'magic 不对');
  }
  if (reader.u8() !== VERSION) fail('ERR_BAD_HEADER', '版本不对');
  const blockSize = reader.u16();
  if (blockSize === 0) fail('ERR_BAD_HEADER', 'blockSize 不能是 0');
  const total = reader.u32();

  const points = [];
  let blocks = 0;
  let timestampBytes = 0;
  let valueBytes = 0;

  while (points.length < total) {
    blocks += 1;
    const blockStart = reader.pos;
    const count = reader.u16();
    if (count < 1 || count > blockSize) {
      fail('ERR_BAD_HEADER', '块条数不在 1..blockSize 里', { count, blockSize });
    }
    if (points.length + count > total) {
      fail('ERR_BAD_HEADER', '块条数加起来超过头里的总条数', { count, total });
    }

    let prevT = reader.i64();
    let prevBits = reader.u64();

    const tsStart = reader.pos;
    const deltas = [];
    let prevDelta = 0n;
    for (let i = 1; i < count; i += 1) {
      const delta = prevDelta + unzigzag(reader.varint());
      deltas.push(delta);
      prevDelta = delta;
    }
    timestampBytes += reader.pos - tsStart;

    const vStart = reader.pos;
    const xors = [];
    for (let i = 1; i < count; i += 1) {
      xors.push(readValue(reader));
    }
    valueBytes += reader.pos - vStart;

    const expected = reader.u32();
    const actual = crc32(bytes, blockStart, reader.pos - CRC_BYTES);
    if (actual !== expected) {
      fail('ERR_CHECKSUM', '块的 CRC32 对不上', { block: blocks - 1 });
    }

    points.push({ t: Number(prevT), v: floatOf(prevBits) });
    for (let i = 1; i < count; i += 1) {
      prevT += deltas[i - 1];
      prevBits ^= xors[i - 1];
      points.push({ t: Number(prevT), v: floatOf(prevBits) });
    }
  }

  if (reader.pos !== bytes.length) {
    fail('ERR_BAD_HEADER', '尾部有多余字节', { offset: reader.pos, length: bytes.length });
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
