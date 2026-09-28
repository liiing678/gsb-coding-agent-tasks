import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeSeries, encodeSeries, stats } from '../lib/tscodec.js';
import { code, hex, series } from './util.js';

test('空序列只有头', () => {
  const bytes = encodeSeries([]);
  assert.equal(bytes.length, 11);
  assert.deepEqual(decodeSeries(bytes), { points: [], blocks: 0 });
  assert.deepEqual(stats(bytes), {
    points: 0, blocks: 0, bytes: 11, headerBytes: 11,
    timestampBytes: 0, valueBytes: 0, overheadBytes: 0,
  });
});

test('同样的输入编出同样的字节', () => {
  const points = [{ t: 0, v: 0 }, { t: 1000, v: 1.5 }, { t: 2000, v: 1.5 }, { t: 2001, v: -2 }];
  const once = encodeSeries(points);
  const twice = encodeSeries(points);
  assert.deepEqual([...once], [...twice]);
  assert.equal(hex(once.slice(0, 11)), '5453434f01007800000004');
  assert.deepEqual(decodeSeries(once).points, points);
});

test('只有一条时块里没有 payload', () => {
  const bytes = encodeSeries([{ t: 42, v: 3.25 }]);
  const summary = stats(bytes);
  assert.equal(summary.timestampBytes, 0);
  assert.equal(summary.valueBytes, 0);
  assert.equal(summary.overheadBytes, 22);
  assert.equal(summary.bytes, 33);
  assert.deepEqual(decodeSeries(bytes), { points: [{ t: 42, v: 3.25 }], blocks: 1 });
});

test('按 blockSize 分块', () => {
  const points = Array.from({ length: 25 }, (_, i) => ({ t: i * 1000, v: i }));
  const bytes = encodeSeries(points, { blockSize: 10 });
  assert.equal(decodeSeries(bytes).blocks, 3);
  assert.equal(stats(bytes).blocks, 3);
  assert.deepEqual(decodeSeries(bytes).points, points);
});

test('头不合法报 ERR_BAD_HEADER，输入不是字节报 ERR_BAD_INPUT', () => {
  const good = encodeSeries([{ t: 1, v: 1 }]);
  const badMagic = Uint8Array.from(good);
  badMagic[1] = 0x58;
  assert.equal(code(() => decodeSeries(badMagic)), 'ERR_BAD_HEADER');
  const badVersion = Uint8Array.from(good);
  badVersion[4] = 2;
  assert.equal(code(() => decodeSeries(badVersion)), 'ERR_BAD_HEADER');
  const badBlockSize = Uint8Array.from(good);
  badBlockSize[5] = 0;
  badBlockSize[6] = 0;
  assert.equal(code(() => decodeSeries(badBlockSize)), 'ERR_BAD_HEADER');
  const badCount = Uint8Array.from(good);
  badCount[10] = 0;
  assert.equal(code(() => decodeSeries(badCount)), 'ERR_BAD_HEADER');
  assert.equal(code(() => decodeSeries('TSCO')), 'ERR_BAD_INPUT');
  assert.equal(code(() => decodeSeries([1, 2, 3])), 'ERR_BAD_INPUT');
});

test('字节不够报 ERR_TRUNCATED', () => {
  const bytes = encodeSeries(series(5));
  assert.equal(code(() => decodeSeries(bytes.slice(0, 8))), 'ERR_TRUNCATED');
  assert.equal(code(() => decodeSeries(bytes.slice(0, 15))), 'ERR_TRUNCATED');
  assert.equal(code(() => decodeSeries(bytes.slice(0, bytes.length - 1))), 'ERR_TRUNCATED');
  assert.equal(code(() => stats(bytes.slice(0, bytes.length - 1))), 'ERR_TRUNCATED');
});

test('crc 对不上报 ERR_CHECKSUM', () => {
  const bytes = encodeSeries(series(4));
  const broken = Uint8Array.from(bytes);
  broken[28] ^= 0x01;
  assert.equal(code(() => decodeSeries(broken)), 'ERR_CHECKSUM');
  assert.equal(code(() => stats(broken)), 'ERR_CHECKSUM');
});

test('尾部多字节或条数对不上报 ERR_BAD_HEADER', () => {
  const bytes = encodeSeries(series(3));
  const longer = new Uint8Array(bytes.length + 1);
  longer.set(bytes);
  assert.equal(code(() => decodeSeries(longer)), 'ERR_BAD_HEADER');
  const fewer = Uint8Array.from(bytes);
  fewer[10] -= 1;
  assert.equal(code(() => decodeSeries(fewer)), 'ERR_BAD_HEADER');
});

test('参数检查', () => {
  assert.equal(code(() => encodeSeries('nope')), 'ERR_BAD_INPUT');
  assert.equal(code(() => encodeSeries([{ t: 1.5, v: 1 }])), 'ERR_BAD_INPUT');
  assert.equal(code(() => encodeSeries([{ t: 1, v: 1 }, { t: 1, v: 2 }])), 'ERR_BAD_INPUT');
  assert.equal(code(() => encodeSeries([{ t: 2, v: 1 }, { t: 1, v: 2 }])), 'ERR_BAD_INPUT');
  assert.equal(code(() => encodeSeries([{ t: 1, v: Number.NaN }])), 'ERR_BAD_INPUT');
  assert.equal(code(() => encodeSeries([{ t: 1, v: Number.POSITIVE_INFINITY }])), 'ERR_BAD_INPUT');
  assert.equal(code(() => encodeSeries([{ t: 1 }])), 'ERR_BAD_INPUT');
  assert.equal(code(() => encodeSeries(series(2), { blockSize: 0 })), 'ERR_BAD_OPTIONS');
  assert.equal(code(() => encodeSeries(series(2), { blockSize: 1.5 })), 'ERR_BAD_OPTIONS');
  assert.equal(code(() => encodeSeries(series(2), { blockSize: '10' })), 'ERR_BAD_OPTIONS');
  assert.equal(code(() => encodeSeries(series(2), { blockSize: 70000 })), 'ERR_BAD_OPTIONS');
});
