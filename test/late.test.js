import test from 'node:test';
import assert from 'node:assert/strict';
import { createAggregator } from '../lib/stream.js';

const base = {
  windowMs: 1000,
  watermarkDelayMs: 0,
  allowedLatenessMs: 0,
  aggregations: ['count', 'sum:bytes', 'avg:bytes'],
};

test('宽限期内来的迟到事件照样算进去', () => {
  const agg = createAggregator({ ...base, allowedLatenessMs: 500 });
  agg.push({ key: 'a', eventTime: 100, values: { bytes: 10 } });
  agg.push({ key: 'a', eventTime: 1200, values: { bytes: 20 } });
  const late = agg.push({ key: 'a', eventTime: 300, values: { bytes: 20 } });
  assert.equal(late.accepted, true);
  assert.equal(late.emitted.length, 1);
  assert.equal(late.emitted[0].windowStart, 0);
  assert.deepEqual(late.emitted[0].values, { count: 2, 'sum:bytes': 30, 'avg:bytes': 15 });
});

test('水位正好顶到宽限期的边，窗口就关', () => {
  const agg = createAggregator({ ...base, allowedLatenessMs: 500 });
  agg.push({ key: 'a', eventTime: 100, values: { bytes: 10 } });
  const out = agg.push({ key: 'a', eventTime: 1500, values: { bytes: 1 } });
  assert.deepEqual(
    out.emitted.map((rec) => [rec.state, rec.windowStart]),
    [
      ['final', 0],
      ['preliminary', 1000],
    ],
  );
});

test('关窗之后才来的迟到事件被丢掉，聚合不再动', () => {
  const agg = createAggregator(base);
  agg.push({ key: 'a', eventTime: 100, values: { bytes: 10 } });
  agg.push({ key: 'a', eventTime: 1000, values: { bytes: 10 } });
  const late = agg.push({ key: 'a', eventTime: 500, values: { bytes: 99 } });
  assert.deepEqual(
    { accepted: late.accepted, reason: late.reason, emitted: late.emitted },
    { accepted: false, reason: 'too-late', emitted: [] },
  );
  assert.equal(agg.get('a', 0).values.count, 1);
  assert.equal(agg.stats().lateDropped, 1);
});

test('水位只增不减，时间倒着来的事件不会把窗口重新打开', () => {
  const agg = createAggregator(base);
  agg.push({ key: 'a', eventTime: 5000, values: { bytes: 1 } });
  const out = agg.push({ key: 'b', eventTime: 100, values: { bytes: 1 } });
  assert.equal(agg.stats().watermark, 5000);
  assert.equal(out.accepted, false);
  assert.equal(agg.get('b', 0), null);
});

test('宽限期里可以来回更新好几次', () => {
  const agg = createAggregator({ ...base, allowedLatenessMs: 2000 });
  agg.push({ key: 'a', eventTime: 100, values: { bytes: 1 } });
  agg.push({ key: 'a', eventTime: 300, values: { bytes: 2 } });
  const out = agg.push({ key: 'a', eventTime: 200, values: { bytes: 3 } });
  assert.equal(out.emitted.length, 1);
  assert.deepEqual(out.emitted[0].values, { count: 3, 'sum:bytes': 6, 'avg:bytes': 2 });
});

test('watermarkDelayMs 把关窗往后推', () => {
  const agg = createAggregator({ ...base, watermarkDelayMs: 300 });
  agg.push({ key: 'a', eventTime: 100, values: { bytes: 1 } });
  const middle = agg.push({ key: 'a', eventTime: 1200, values: { bytes: 1 } });
  assert.equal(agg.stats().watermark, 900);
  assert.deepEqual(
    middle.emitted.map((rec) => [rec.state, rec.windowStart]),
    [['preliminary', 1000]],
  );
  const closing = agg.push({ key: 'a', eventTime: 1400, values: { bytes: 1 } });
  assert.equal(agg.stats().watermark, 1100);
  assert.deepEqual(
    closing.emitted.map((rec) => [rec.state, rec.windowStart]),
    [
      ['final', 0],
      ['preliminary', 1000],
    ],
  );
});
