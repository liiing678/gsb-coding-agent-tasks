import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeSeries, encodeSeries, stats } from '../lib/tscodec.js';
import { roundTrip, series } from './util.js';

test('往返：各种值都原样回来（含 -0）', () => {
  const points = [
    { t: -5000, v: 0 }, { t: 0, v: -0 }, { t: 1, v: 1e-7 }, { t: 2, v: 1e308 },
    { t: 3, v: -1e308 }, { t: 4, v: 0.1 }, { t: 5, v: 3 }, { t: 6, v: 3 },
  ];
  const decoded = roundTrip(points);
  assert.equal(decoded.length, points.length);
  for (let i = 0; i < points.length; i += 1) {
    assert.equal(decoded[i].t, points[i].t);
    assert.ok(Object.is(decoded[i].v, points[i].v), `第 ${i} 条的值没原样回来`);
  }
});

test('固定步长：时间戳那一段几乎不占地方', () => {
  const points = series(100);
  const bytes = encodeSeries(points);
  const summary = stats(bytes);
  assert.equal(summary.points, 100);
  assert.equal(summary.blocks, 1);
  assert.equal(summary.timestampBytes, 100);
  assert.ok(summary.valueBytes < 99 * 9);
  assert.deepEqual(decodeSeries(bytes).points, points);
});

test('重复的值只花一个字节', () => {
  const points = [{ t: 0, v: 7 }, { t: 1, v: 7 }, { t: 2, v: 7 }];
  const summary = stats(encodeSeries(points));
  assert.equal(summary.valueBytes, 2);
  assert.equal(summary.timestampBytes, 2);
});

test('分段字节加起来等于总字节', () => {
  const bytes = encodeSeries(series(37), { blockSize: 10 });
  const summary = stats(bytes);
  assert.equal(summary.blocks, 4);
  assert.equal(summary.bytes, bytes.length);
  assert.equal(
    summary.headerBytes + summary.timestampBytes + summary.valueBytes + summary.overheadBytes,
    bytes.length,
  );
  assert.equal(summary.overheadBytes, 4 * 22);
});

test('跨块的 delta 不串味', () => {
  const points = Array.from({ length: 15 }, (_, i) => ({ t: i * 100, v: i * 2 }));
  const bytes = encodeSeries(points, { blockSize: 5 });
  assert.equal(decodeSeries(bytes).blocks, 3);
  assert.deepEqual(decodeSeries(bytes).points, points);
});
