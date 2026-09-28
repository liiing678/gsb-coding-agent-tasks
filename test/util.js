import { FlateError } from '../lib/errors.js';

export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof FlateError ? err.code : `NOT_FLATE:${err.message}`;
  }
};

export const text = (value) => Buffer.from(value, 'utf8');
export const toText = (bytes) => Buffer.from(bytes).toString('utf8');

// 固定霍夫曼表：字面/长度 288 项，距离 32 项（30 / 31 是非法码，但仍然占着码位）
export const FIXED_LIT_LENGTHS = (() => {
  const lengths = new Array(288).fill(8);
  for (let symbol = 144; symbol <= 255; symbol += 1) lengths[symbol] = 9;
  for (let symbol = 256; symbol <= 279; symbol += 1) lengths[symbol] = 7;
  return lengths;
})();
export const FIXED_DIST_LENGTHS = new Array(32).fill(5);

export function canonicalCodes(lengths) {
  let maxLen = 0;
  for (const length of lengths) if (length > maxLen) maxLen = length;
  const counts = new Array(maxLen + 1).fill(0);
  for (const length of lengths) if (length > 0) counts[length] += 1;
  const next = new Array(maxLen + 1).fill(0);
  let value = 0;
  for (let len = 1; len <= maxLen; len += 1) {
    value = (value + (len > 1 ? counts[len - 1] : 0)) << 1;
    next[len] = value;
  }
  const codes = new Array(lengths.length).fill(0);
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol];
    if (length > 0) codes[symbol] = next[length]++;
  }
  return codes;
}

export const FIXED_LIT_CODES = canonicalCodes(FIXED_LIT_LENGTHS);
export const FIXED_DIST_CODES = canonicalCodes(FIXED_DIST_LENGTHS);

// DEFLATE 的位是低字节序：普通字段低位在前，霍夫曼码字高位在前。
export class BitWriter {
  constructor() {
    this.bits = [];
  }

  writeBits(value, count) {
    for (let i = 0; i < count; i += 1) this.bits.push((value >>> i) & 1);
    return this;
  }

  writeCode(code, count) {
    for (let i = count - 1; i >= 0; i -= 1) this.bits.push((code >>> i) & 1);
    return this;
  }

  writeLit(symbol) {
    return this.writeCode(FIXED_LIT_CODES[symbol], FIXED_LIT_LENGTHS[symbol]);
  }

  writeDist(symbol) {
    return this.writeCode(FIXED_DIST_CODES[symbol], FIXED_DIST_LENGTHS[symbol]);
  }

  align() {
    while (this.bits.length % 8 !== 0) this.bits.push(0);
    return this;
  }

  writeRawBytes(bytes) {
    this.align();
    for (const byte of bytes) {
      for (let i = 0; i < 8; i += 1) this.bits.push((byte >>> i) & 1);
    }
    return this;
  }

  toBytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, index) => {
      if (bit) out[index >> 3] |= 1 << (index & 7);
    });
    return out;
  }
}