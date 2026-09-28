import test from 'node:test';
import assert from 'node:assert/strict';
import { createAggregator } from '../lib/stream.js';

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'AggError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

const base = { windowMs: 1000, allowedLatenessMs: 0, aggregations: ['count', 'sum:bytes'] };

test('stats 的数字对得上', () => {
  const agg = createAggregator(base);
  agg.push({ key: 'a', eventTime: 100, values: { bytes: 1 } });
  agg.push({ key: 'b', eventTime: 200, values: { bytes: 1 } });
  agg.push({ key: 'a', eventTime: 1500, values: { bytes: 1 } });
  assert.deepEqual(agg.stats(), {
    watermark: 1500,
    maxEventTime: 1500,
    windows: 3,
    openWindows: 1,
    closedWindows: 2,
    emitted: 5,
    lateDropped: 0,
  });
});

test('advanceTo 把水位抬起来关窗，往回给的值不算数', () => {
  const agg = createAggregator(base);
  agg.push({ key: 'a', eventTime: 100, values: { bytes: 1 } });
  const out = agg.advanceTo(1000);
  assert.deepEqual(
    out.emitted.map((rec) => [rec.state, rec.windowStart, rec.seq]),
    [['final', 0, 2]],
  );
  assert.equal(agg.stats().watermark, 1000);
  assert.deepEqual(agg.advanceTo(500).emitted, []);
  assert.equal(agg.stats().watermark, 1000);
  expectError(() => agg.advanceTo(1.5), 'ERR_BAD_CONFIG');
});

test('过了保留期，关掉的窗口整个放掉', () => {
  const agg = createAggregator({ ...base, retentionMs: 2000 });
  agg.push({ key: 'a', eventTime: 100, values: { bytes: 1 } });
  agg.push({ key: 'a', eventTime: 1000, values: { bytes: 1 } });
  assert.equal(agg.get('a', 0).state, 'closed');
  assert.equal(agg.stats().windows, 2);
  agg.push({ key: 'a', eventTime: 4000, values: { bytes: 1 } });
  assert.equal(agg.get('a', 0), null);
  assert.equal(agg.stats().windows, 2);
});

test('关掉的窗口还查得到，直到被放掉', () => {
  const agg = createAggregator(base);
  agg.push({ key: 'a', eventTime: 100, values: { bytes: 1 } });
  agg.push({ key: 'a', eventTime: 1000, values: { bytes: 1 } });
  const closed = agg.get('a', 0);
  assert.equal(closed.state, 'closed');
  assert.equal(closed.closedAt, 1000);
  assert.deepEqual(closed.values, { count: 1, 'sum:bytes': 1 });
});

test('windows() 按 windowStart 再按 key 排', () => {
  const agg = createAggregator(base);
  agg.push({ key: 'b', eventTime: 100, values: { bytes: 1 } });
  agg.push({ key: 'a', eventTime: 100, values: { bytes: 1 } });
  agg.push({ key: 'a', eventTime: 1100, values: { bytes: 1 } });
  assert.deepEqual(
    agg.windows().map((win) => [win.windowStart, win.key]),
    [
      [0, 'a'],
      [0, 'b'],
      [1000, 'a'],
    ],
  );
});

test('配置写错报 ERR_BAD_CONFIG', () => {
  expectError(() => createAggregator({ windowMs: 0 }), 'ERR_BAD_CONFIG');
  expectError(() => createAggregator({ watermarkDelayMs: -1 }), 'ERR_BAD_CONFIG');
  expectError(() => createAggregator({ aggregations: [] }), 'ERR_BAD_CONFIG');
  const err = expectError(
    () => createAggregator({ aggregations: ['median:bytes'] }),
    'ERR_BAD_CONFIG',
  );
  assert.equal(err.details.spec, 'median:bytes');
  expectError(() => createAggregator({ aggregations: ['sum'] }), 'ERR_BAD_CONFIG');
});

test('事件写错报 ERR_BAD_EVENT', () => {
  const agg = createAggregator(base);
  const bad = [
    ['key', { key: '', eventTime: 1, values: { bytes: 1 } }],
    ['eventTime', { key: 'a', eventTime: 1.5, values: { bytes: 1 } }],
    ['eventTime', { key: 'a', eventTime: -1, values: { bytes: 1 } }],
    ['values.bytes', { key: 'a', eventTime: 1, values: {} }],
    ['values.bytes', { key: 'a', eventTime: 1, values: { bytes: 'ten' } }],
  ];
  for (const [field, event] of bad) {
    const err = expectError(() => agg.push(event), 'ERR_BAD_EVENT');
    assert.equal(err.details.field, field);
  }
  assert.equal(agg.stats().emitted, 0);
});
