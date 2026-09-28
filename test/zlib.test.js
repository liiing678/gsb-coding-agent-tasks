import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { adler32, inflateZlib } from '../lib/flate.js';
import { code, text, toText } from './util.js';

const sample = () => text('zlib wrapper round trip; '.repeat(120));

test('zlib 包装的流能解回原样', () => {
  const data = sample();
  for (const level of [0, 1, 6, 9]) {
    assert.deepEqual(Buffer.from(inflateZlib(zlib.deflateSync(data, { level }))), data);
  }
  assert.deepEqual(inflateZlib(zlib.deflateSync(Buffer.alloc(0))), new Uint8Array(0));
  assert.equal(toText(inflateZlib(zlib.deflateSync(text('')))), '');
});

test('zlib 头不对就 ERR_BAD_ZLIB', () => {
  assert.equal(code(() => inflateZlib(Buffer.from([0x78]))), 'ERR_BAD_ZLIB');
  assert.equal(code(() => inflateZlib(Buffer.from([0x78, 0x02]))), 'ERR_BAD_ZLIB');   // FCHECK
  assert.equal(code(() => inflateZlib(Buffer.from([0x98, 0x18]))), 'ERR_BAD_ZLIB');   // CM
  assert.equal(code(() => inflateZlib(Buffer.from([0x78, 0x20]))), 'ERR_BAD_ZLIB');   // FDICT
});

test('Adler-32 的已知值', () => {
  assert.equal(adler32(new Uint8Array(0)), 1);
  assert.equal(adler32(text('a')), 0x00620062);
  assert.equal(adler32(text('abc')), 0x024d0127);
  assert.equal(adler32(text('Wikipedia')), 0x11e60398);
  assert.equal(adler32(Buffer.alloc(1000, 0x78)), 0xaaf4d4d0);
});

test('尾部 Adler-32 改过 / 缺了 / 多了都要报出来', () => {
  const wrapped = zlib.deflateSync(sample(), { level: 6 });
  const corrupted = Buffer.from(wrapped);
  corrupted[corrupted.length - 1] ^= 0xff;
  assert.equal(code(() => inflateZlib(corrupted)), 'ERR_CHECKSUM');

  assert.equal(code(() => inflateZlib(wrapped.subarray(0, wrapped.length - 2))), 'ERR_TRUNCATED');
  assert.equal(code(() => inflateZlib(Buffer.concat([wrapped, Buffer.from([0])]))), 'ERR_BAD_ZLIB');
});