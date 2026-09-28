import test from 'node:test';
import assert from 'node:assert/strict';
import { createAggregator } from '../lib/stream.js';

const full = {
  windowMs: 1000,
  watermarkDelayMs: 0,
  allowedLatenessMs: 0,
  aggregations: ['count', 'sum:bytes', 'min:bytes', 'max:bytes', 'avg:bytes'],
};

test('窗口按 eventTime 切，同一个窗口的事件合起来', () => {
  const agg = createAggregator(full);
  const first = agg.push({ key: 'tenant-a', eventTime: 100, values: { bytes: 10 } });
  assert.equal(first.accepted, true);
  assert.deepEqual(first.emitted, [
    {
      seq: 1,
      key: 'tenant-a',
      windowStart: 0,
      windowEnd: 1000,
      state: 'preliminary',
      values: { count: 1, 'sum:bytes': 10, 'min:bytes': 10, 'max:bytes': 10, 'avg:bytes': 10 },
    },
  ]);

  const second = agg.push({ key: 'tenant-a', eventTime: 900, values: { bytes: 20 } });
  assert.deepEqual(second.emitted[0].values, {
    count: 2,
    'sum:bytes': 30,
    'min:bytes': 10,
    'max:bytes': 20,
    'avg:bytes': 15,
  });
});

test('不同的 key 各算各的窗口', () => {
  const agg = createAggregator(full);
  agg.push({ key: 'a', eventTime: 100, values: { bytes: 1 } });
  agg.push({ key: 'b', eventTime: 200, values: { bytes: 5 } });
  assert.equal(agg.get('a', 0).values.count, 1);
  assert.equal(agg.get('b', 0).values.count, 1);
  assert.equal(agg.get('b', 0).values['sum:bytes'], 5);
  assert.equal(agg.get('a', 1000), null);
});

test('过了窗口边界就落到下一个窗口', () => {
  const agg = createAggregator(full);
  agg.push({ key: 'a', eventTime: 999, values: { bytes: 1 } });
  const second = agg.push({ key: 'a', eventTime: 1000, values: { bytes: 1 } });
  assert.equal(second.emitted.at(-1).windowStart, 1000);
  assert.equal(agg.get('a', 0).values.count, 1);
  assert.equal(agg.get('a', 1000).values.count, 1);
});

test('水位走到窗口末尾，窗口就关掉并发 final', () => {
  const agg = createAggregator(full);
  agg.push({ key: 'a', eventTime: 100, values: { bytes: 10 } });
  const out = agg.push({ key: 'a', eventTime: 1000, values: { bytes: 3 } });
  assert.deepEqual(
    out.emitted.map((rec) => [rec.seq, rec.state, rec.windowStart]),
    [
      [2, 'final', 0],
      [3, 'preliminary', 1000],
    ],
  );
  assert.equal(out.emitted[0].values.count, 1);
});

test('一次跳跃关掉好几个窗口，先按 windowEnd 再按 key 排', () => {
  const agg = createAggregator(full);
  agg.push({ key: 'a', eventTime: 100, values: { bytes: 1 } });
  agg.push({ key: 'b', eventTime: 150, values: { bytes: 1 } });
  const out = agg.push({ key: 'a', eventTime: 5000, values: { bytes: 1 } });
  assert.deepEqual(
    out.emitted.map((rec) => [rec.seq, rec.state, rec.key, rec.windowStart]),
    [
      [3, 'final', 'a', 0],
      [4, 'final', 'b', 0],
      [5, 'preliminary', 'a', 5000],
    ],
  );
});

test('final 的数值跟最后一次 preliminary 一样', () => {
  const agg = createAggregator(full);
  agg.push({ key: 'a', eventTime: 100, values: { bytes: 10 } });
  const last = agg.push({ key: 'a', eventTime: 200, values: { bytes: 20 } });
  const closing = agg.push({ key: 'a', eventTime: 1500, values: { bytes: 1 } });
  const final = closing.emitted.find((rec) => rec.state === 'final');
  assert.deepEqual(final.values, last.emitted[0].values);
});

test('flush 把还开着的窗口都收掉，之后老事件算迟到', () => {
  const agg = createAggregator(full);
  agg.push({ key: 'a', eventTime: 100, values: { bytes: 1 } });
  agg.push({ key: 'b', eventTime: 150, values: { bytes: 1 } });
  const flushed = agg.flush();
  assert.deepEqual(
    flushed.emitted.map((rec) => [rec.state, rec.key, rec.windowStart]),
    [
      ['final', 'a', 0],
      ['final', 'b', 0],
    ],
  );
  assert.equal(agg.stats().openWindows, 0);
  const late = agg.push({ key: 'a', eventTime: 100, values: { bytes: 1 } });
  assert.deepEqual({ accepted: late.accepted, reason: late.reason }, { accepted: false, reason: 'too-late' });
});
