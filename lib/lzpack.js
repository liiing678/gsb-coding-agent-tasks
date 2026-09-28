import { PackError } from './errors.js';

export const DEFAULTS = Object.freeze({ window: 4096, minMatch: 3, maxMatch: 18 });

const MAGIC = [0x4c, 0x5a, 0x50, 0x31];
const HEADER_SIZE = 12;
const MAX_SIZE = 1 << 26;

const needBytes = (data, name) => {
  if (!(data instanceof Uint8Array)) {
    throw new PackError('ERR_BAD_ARGS', `${name} 只收 Uint8Array`, { got: data });
  }
};

export const checksum = (data) => {
  needBytes(data, 'checksum');
  let hash = 0x811c9dc5;
  for (let at = 0; at < data.length; at += 1) {
    hash = Math.imul(hash ^ data[at], 0x01000193) >>> 0;
  }
  return hash;
};

// 站在 at 往前找最长匹配；长度一样时离得近的优先（候选从近到远扫，严格更长才换）。
const findMatch = (data, at) => {
  const left = Math.max(0, at - DEFAULTS.window);
  const room = Math.min(DEFAULTS.maxMatch, data.length - at);
  let bestLength = 0;
  let bestDistance = 0;
  for (let from = at - 1; from >= left; from -= 1) {
    let length = 0;
    while (length < room && data[from + length] === data[at + length]) {
      length += 1;
    }
    if (length > bestLength) {
      bestLength = length;
      bestDistance = at - from;
      if (length >= room) break;
    }
  }
  if (bestLength < DEFAULTS.minMatch) return null;
  return { distance: bestDistance, length: bestLength };
};

export const compress = (data) => {
  needBytes(data, 'compress');
  const out = [...MAGIC, 0, 0, 0, 0, 0, 0, 0, 0];
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, data.length, true);
  view.setUint32(4, checksum(data), true);
  for (let at = 0; at < 8; at += 1) out[4 + at] = view.getUint8(at);

  let at = 0;
  while (at < data.length) {
    const flagAt = out.length;
    out.push(0);
    let flags = 0;
    for (let slot = 0; slot < 8 && at < data.length; slot += 1) {
      const match = findMatch(data, at);
      if (match === null) {
        flags |= 1 << slot;
        out.push(data[at]);
        at += 1;
      } else {
        const value = ((match.length - DEFAULTS.minMatch) << 12) | (match.distance - 1);
        out.push(value & 0xff, (value >>> 8) & 0xff);
        at += match.length;
      }
    }
    out[flagAt] = flags;
  }
  return Uint8Array.from(out);
};

export const decompress = (packed) => {
  needBytes(packed, 'decompress');
  if (packed.length < HEADER_SIZE || MAGIC.some((byte, at) => packed[at] !== byte)) {
    throw new PackError('ERR_BAD_HEADER', '头部不足 12 字节或 magic 不对');
  }
  const view = new DataView(packed.buffer, packed.byteOffset, HEADER_SIZE);
  const size = view.getUint32(4, true);
  const want = view.getUint32(8, true);
  if (size > MAX_SIZE) {
    throw new PackError('ERR_CORRUPT', '头部写的原始长度超过 64MiB', { size });
  }

  const corrupt = (message) => new PackError('ERR_CORRUPT', message);
  const out = new Uint8Array(size);
  let written = 0;
  let at = HEADER_SIZE;

  while (written < size) {
    if (at >= packed.length) throw corrupt('标志字节读到一半载荷就没了');
    const flags = packed[at];
    at += 1;
    for (let slot = 0; slot < 8 && written < size; slot += 1) {
      if (flags & (1 << slot)) {
        if (at >= packed.length) throw corrupt('字面量读到一半载荷就没了');
        out[written] = packed[at];
        at += 1;
        written += 1;
      } else {
        if (at + 2 > packed.length) throw corrupt('匹配读到一半载荷就没了');
        const value = packed[at] | (packed[at + 1] << 8);
        at += 2;
        const distance = (value & 0xfff) + 1;
        const length = (value >>> 12) + DEFAULTS.minMatch;
        if (distance > written) throw corrupt('匹配的距离比已解出的字节数还大');
        if (written + length > size) throw corrupt('匹配会让输出超过头部写的原始长度');
        for (let back = 0; back < length; back += 1) {
          out[written] = out[written - distance];
          written += 1;
        }
      }
    }
  }

  if (at !== packed.length) throw corrupt('原始长度凑够了，载荷后面还剩着字节');
  if (checksum(out) !== want) throw corrupt('校验和对不上');
  return out;
};
