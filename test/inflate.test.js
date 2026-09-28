import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { inflateRaw } from '../lib/flate.js';
import { BitWriter, code, text, toText } from './util.js';

const sample = () => text('the quick brown fox jumps over the lazy dog. '.repeat(200));

test('stored / 固定 / 动态三种块都能解回原样', () => {
  const data = sample();
  for (const level of [0, 1, 6, 9]) {
    const raw = zlib.deflateRawSync(data, { level });
    assert.deepEqual(Buffer.from(inflateRaw(raw)), data, `level ${level}`);
  }
  const fixed = zlib.deflateRawSync(data, { strategy: zlib.constants.Z_FIXED });
  assert.deepEqual(Buffer.from(inflateRaw(fixed)), data);
  const huffmanOnly = zlib.deflateRawSync(data, { strategy: zlib.constants.Z_HUFFMAN_ONLY });
  assert.deepEqual(Buffer.from(inflateRaw(huffmanOnly)), data);
  assert.deepEqual(inflateRaw(zlib.deflateRawSync(Buffer.alloc(0))), new Uint8Array(0));
  assert.equal(toText(inflateRaw(zlib.deflateRawSync(text('')))), '');
});

test('多块的大输入能一路解完，尾随垃圾字节不影响', () => {
  const data = Buffer.alloc(300 * 1024);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 31 + (i >> 8)) & 0xff;
  for (const level of [0, 6]) {
    const raw = zlib.deflateRawSync(data, { level });
    assert.deepEqual(Buffer.from(inflateRaw(raw)), data, `level ${level}`);
    const withTail = Buffer.concat([raw, Buffer.from([0xde, 0xad, 0xbe, 0xef])]);
    assert.deepEqual(Buffer.from(inflateRaw(withTail)), data, `level ${level} 带尾巴`);
  }
});

test('手写的 stored 块：LEN / NLEN 要对得上', () => {
  const payload = Buffer.from('stored block payload', 'utf8');
  const writer = new BitWriter();
  writer.writeBits(1, 1);
  writer.writeBits(0, 2);
  writer.writeRawBytes(Buffer.from([payload.length & 0xff, payload.length >> 8,
    (~payload.length) & 0xff, ((~payload.length) >> 8) & 0xff]));
  writer.writeRawBytes(payload);
  assert.equal(toText(inflateRaw(writer.toBytes())), 'stored block payload');

  const broken = new BitWriter();
  broken.writeBits(1, 1);
  broken.writeBits(0, 2);
  broken.writeRawBytes(Buffer.from([payload.length & 0xff, payload.length >> 8,
    payload.length & 0xff, payload.length >> 8]));
  broken.writeRawBytes(payload);
  assert.equal(code(() => inflateRaw(broken.toBytes())), 'ERR_BAD_LENGTH');
});

test('手写的固定块：重叠复制、距离越界、286 / 287、保留块类型', () => {
  const overlap = new BitWriter();
  overlap.writeBits(1, 1).writeBits(1, 2);
  overlap.writeLit(97);          // 'a'
  overlap.writeLit(257);         // 长度 3
  overlap.writeDist(0);          // 距离 1
  overlap.writeLit(256);         // 块结束
  assert.equal(toText(inflateRaw(overlap.toBytes())), 'aaaa');

  const far = new BitWriter();
  far.writeBits(1, 1).writeBits(1, 2);
  far.writeLit(97);
  far.writeLit(257);
  far.writeDist(4);              // 距离码 4：基数 5，还要读 1 位
  far.writeBits(0, 1);
  far.writeLit(256);
  assert.equal(code(() => inflateRaw(far.toBytes())), 'ERR_BAD_DISTANCE');

  for (const symbol of [286, 287]) {
    const bad = new BitWriter();
    bad.writeBits(1, 1).writeBits(1, 2);
    bad.writeLit(symbol);
    assert.equal(code(() => inflateRaw(bad.toBytes())), 'ERR_BAD_LENGTH', `符号 ${symbol}`);
  }

  const reserved = new BitWriter();
  reserved.writeBits(1, 1).writeBits(3, 2);
  reserved.writeBits(0, 8);
  assert.equal(code(() => inflateRaw(reserved.toBytes())), 'ERR_BAD_BLOCK');
});

test('截断的流一律 ERR_TRUNCATED', () => {
  const data = sample();
  for (const level of [0, 6]) {
    const raw = zlib.deflateRawSync(data, { level });
    const cut = raw.subarray(0, Math.floor(raw.length * 0.4));
    assert.equal(code(() => inflateRaw(cut)), 'ERR_TRUNCATED', `level ${level}`);
  }
  const partial = new BitWriter();
  partial.writeBits(1, 1).writeBits(0, 2);
  partial.writeRawBytes(Buffer.from([4, 0, 0xfb, 0xff]));
  partial.writeRawBytes(Buffer.from([1, 2]));
  assert.equal(code(() => inflateRaw(partial.toBytes())), 'ERR_TRUNCATED');
  assert.equal(code(() => inflateRaw(new Uint8Array(0))), 'ERR_TRUNCATED');
});

test('入参不是 Uint8Array 就是 ERR_BAD_INPUT', () => {
  for (const value of ['abc', [1, 2, 3], new ArrayBuffer(4), null, undefined, 7, {}]) {
    assert.equal(code(() => inflateRaw(value)), 'ERR_BAD_INPUT');
  }
});