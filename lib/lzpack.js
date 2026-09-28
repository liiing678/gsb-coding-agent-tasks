// LZSS 打包与解包。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/roundtrip.test.js、test/format.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import { PackError } from './errors.js';

export const DEFAULTS = {
  window: 4096,
  minMatch: 3,
  maxMatch: 18,
};

const MAGIC = [0x4c, 0x5a, 0x50, 0x31]; // 'L' 'Z' 'P' '1'
const HEADER_SIZE = 12;
const MAX_ORIGINAL = 1 << 26; // 64MiB，超过直接判损坏，不分配内存

const fail = (code, message) => {
  throw new PackError(code, message);
};

const asBytes = (value) => {
  if (!(value instanceof Uint8Array)) {
    fail('ERR_BAD_ARGS', '入参必须是 Uint8Array');
  }
  return value;
};

const readUInt32LE = (bytes, offset) => (
  bytes[offset]
  | (bytes[offset + 1] << 8)
  | (bytes[offset + 2] << 16)
  | (bytes[offset + 3] << 24)
) >>> 0;

export function checksum(bytes) {
  const input = asBytes(bytes);
  let hash = 0x811c9dc5;
  for (let at = 0; at < input.length; at += 1) {
    hash = Math.imul(hash ^ input[at], 0x01000193) >>> 0;
  }
  return hash;
}

export function compress(input) {
  const data = asBytes(input);
  const { window: WINDOW, minMatch: MIN_MATCH, maxMatch: MAX_MATCH } = DEFAULTS;

  const payload = [];
  let p = 0;
  while (p < data.length) {
    // 一组最多 8 个条目，组首是标志字节，先占个位。
    const flagsAt = payload.length;
    payload.push(0);
    let flags = 0;
    for (let slot = 0; slot < 8 && p < data.length; slot += 1) {
      const limit = Math.min(MAX_MATCH, data.length - p);
      let bestLen = 0;
      let bestDist = 0;
      if (limit >= MIN_MATCH) {
        const earliest = Math.max(0, p - WINDOW);
        // 从离当前最近的候选往远扫，长度严格更长才替换：
        // 一样长时留下的自然就是距离最小（最近）的那个。
        for (let cand = p - 1; cand >= earliest; cand -= 1) {
          let k = 0;
          while (k < limit && data[cand + k] === data[p + k]) {
            k += 1;
          }
          if (k > bestLen) {
            bestLen = k;
            bestDist = p - cand;
            if (bestLen === limit) {
              break; // 已到本次匹配的硬上限，更远的候选不可能更长
            }
          }
        }
      }
      if (bestLen >= MIN_MATCH) {
        const value = ((bestLen - MIN_MATCH) << 12) | (bestDist - 1);
        payload.push(value & 0xff, value >>> 8);
        p += bestLen;
      } else {
        flags |= 1 << slot;
        payload.push(data[p]);
        p += 1;
      }
    }
    payload[flagsAt] = flags;
  }

  const packed = new Uint8Array(HEADER_SIZE + payload.length);
  packed.set(MAGIC, 0);
  const view = new DataView(packed.buffer);
  view.setUint32(4, data.length, true);
  view.setUint32(8, checksum(data), true);
  packed.set(payload, HEADER_SIZE);
  return packed;
}

export function decompress(packed) {
  const data = asBytes(packed);
  if (data.length < HEADER_SIZE) {
    fail('ERR_BAD_HEADER', '不足 12 字节的头');
  }
  for (let at = 0; at < MAGIC.length; at += 1) {
    if (data[at] !== MAGIC[at]) {
      fail('ERR_BAD_HEADER', 'magic 不是 LZP1');
    }
  }

  const originalLength = readUInt32LE(data, 4);
  if (originalLength > MAX_ORIGINAL) {
    fail('ERR_CORRUPT', '头部写的原始长度超过 64MiB');
  }
  const expectedChecksum = readUInt32LE(data, 8);

  const output = new Uint8Array(originalLength);
  let ip = HEADER_SIZE;
  let op = 0;
  while (op < originalLength) {
    if (ip >= data.length) {
      fail('ERR_CORRUPT', '标志字节缺失，载荷被截断');
    }
    const flags = data[ip];
    ip += 1;
    for (let slot = 0; slot < 8 && op < originalLength; slot += 1) {
      if ((flags & (1 << slot)) !== 0) {
        if (ip >= data.length) {
          fail('ERR_CORRUPT', '字面量读到一半载荷没了');
        }
        output[op] = data[ip];
        ip += 1;
        op += 1;
      } else {
        if (ip + 1 >= data.length) {
          fail('ERR_CORRUPT', '匹配的两个字节没读全');
        }
        const value = data[ip] | (data[ip + 1] << 8);
        ip += 2;
        const distance = (value & 0x0fff) + 1;
        const matchLength = (value >>> 12) + 3;
        if (distance > op) {
          fail('ERR_CORRUPT', '匹配距离超过已解出的字节数');
        }
        if (op + matchLength > originalLength) {
          fail('ERR_CORRUPT', '匹配长度会让输出超过原始长度');
        }
        // 距离可能比匹配长度小（重叠拷贝），逐字节抄才能自己刷自己。
        for (let k = 0; k < matchLength; k += 1) {
          output[op + k] = output[op + k - distance];
        }
        op += matchLength;
      }
    }
  }

  if (ip !== data.length) {
    fail('ERR_CORRUPT', '原始长度凑够后载荷还挂着尾巴');
  }
  if (checksum(output) !== expectedChecksum) {
    fail('ERR_CORRUPT', '校验和与头部记录不一致');
  }
  return output;
}
