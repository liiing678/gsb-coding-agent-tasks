import test from 'node:test';
import assert from 'node:assert/strict';

import { compress, decompress, checksum } from '../lib/lzpack.js';
import { PackError } from '../lib/errors.js';
import { bytes, concat, fromHex, hex, repeat } from './util.js';

const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

// 按口径手工拼一个包：八条目一组，标志位从最低位开始。
const frame = (entries, size, want = null) => {
  const payload = [];
  for (let at = 0; at < entries.length; at += 8) {
    const group = entries.slice(at, at + 8);
    let flags = 0;
    const body = [];
    group.forEach((entry, slot) => {
      if (entry.literal !== undefined) {
        flags |= 1 << slot;
        body.push(entry.literal);
        return;
      }
      const value = ((entry.length - 3) << 12) | (entry.distance - 1);
      body.push(value & 0xff, (value >>> 8) & 0xff);
    });
    payload.push(flags, ...body);
  }
  const head = [0x4c, 0x5a, 0x50, 0x31];
  const write = (list, value) => list.push(
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
  );
  write(head, size);
  write(head, want === null ? 0 : want);
  return Uint8Array.from([...head, ...payload]);
};

test('头不对就是 ERR_BAD_HEADER', () => {
  assert.equal(code(() => decompress(bytes())), 'ERR_BAD_HEADER');
  assert.equal(code(() => decompress(fromHex('4c 5a 50 31 00 00 00'))), 'ERR_BAD_HEADER');
  assert.equal(code(() => decompress(concat(bytes(0x00, 0x5a, 0x50, 0x31), bytes(0, 0, 0, 0, 0, 0, 0, 0)))),
    'ERR_BAD_HEADER');
  const packed = compress(bytes(1, 2, 3));
  packed[0] = 0x4d;
  assert.equal(code(() => decompress(packed)), 'ERR_BAD_HEADER');
});

test('载荷被切断就是 ERR_CORRUPT', () => {
  const packed = compress(repeat(0x41, 64));
  assert.equal(code(() => decompress(packed.subarray(0, packed.length - 1))), 'ERR_CORRUPT');
  assert.equal(code(() => decompress(packed.subarray(0, 13))), 'ERR_CORRUPT');
});

test('头部写的长度或者校验和对不上就是 ERR_CORRUPT', () => {
  const packed = compress(new TextEncoder().encode('hello hello hello'));

  const shorter = Uint8Array.from(packed);
  shorter[4] = 4;
  assert.equal(code(() => decompress(shorter)), 'ERR_CORRUPT');

  const tampered = Uint8Array.from(packed);
  tampered[13] = tampered[13] ^ 0xff;
  assert.equal(code(() => decompress(tampered)), 'ERR_CORRUPT');

  const huge = Uint8Array.from(packed);
  huge[4] = 0xff;
  huge[5] = 0xff;
  huge[6] = 0xff;
  huge[7] = 0xff;
  assert.equal(code(() => decompress(huge)), 'ERR_CORRUPT');
});

test('载荷后面多出来的字节也算损坏', () => {
  const packed = compress(bytes(7, 7, 7, 7, 7, 7));
  const padded = concat(packed, bytes(0x00));
  assert.equal(code(() => decompress(padded)), 'ERR_CORRUPT');
});

test('距离正好 4096 的两字节匹配能解开', () => {
  const entries = [];
  for (let at = 0; at < 4096; at += 1) entries.push({ literal: at & 0xff });
  entries.push({ distance: 4096, length: 3 });
  const body = new Uint8Array(4099);
  for (let at = 0; at < 4096; at += 1) body[at] = at & 0xff;
  body[4096] = body[0];
  body[4097] = body[1];
  body[4098] = body[2];

  const packed = frame(entries, 4099, checksum(body));
  const back = decompress(packed);
  assert.deepEqual([...back], [...body]);
  assert.equal(back[4096], back[0]);
});

test('距离和长度越界都当场拦住，贴着上限的写法要能解开', () => {
  // 才刚解出三个字节，却要往前找 100 个字节
  const tooFar = frame([
    { literal: 1 }, { literal: 2 }, { literal: 3 },
    { distance: 100, length: 3 },
  ], 6, 0);
  assert.equal(code(() => decompress(tooFar)), 'ERR_CORRUPT');

  // 头部说只有 4 个字节，匹配却要吐 18 个
  const tooLong = frame([{ literal: 1 }, { distance: 1, length: 18 }], 4, 0);
  assert.equal(code(() => decompress(tooLong)), 'ERR_CORRUPT');

  // 距离 1 的最长匹配：自己刷自己，18 个字节正好填满
  const flat = new Uint8Array(19).fill(9);
  const overrun = frame([{ literal: 9 }, { distance: 1, length: 18 }], 19, checksum(flat));
  const back = decompress(overrun);
  assert.equal(back.length, 19);
  assert.equal(hex(back.subarray(0, 3)), '09 09 09');
});

test('不入参一律 ERR_BAD_ARGS', () => {
  assert.equal(code(() => compress([1, 2, 3])), 'ERR_BAD_ARGS');
  assert.equal(code(() => compress('abc')), 'ERR_BAD_ARGS');
  assert.equal(code(() => compress(null)), 'ERR_BAD_ARGS');
  assert.equal(code(() => decompress(new Int8Array(12))), 'ERR_BAD_ARGS');
  assert.equal(code(() => checksum(undefined)), 'ERR_BAD_ARGS');
  assert.ok(new PackError('ERR_CORRUPT', 'x') instanceof Error);
});
