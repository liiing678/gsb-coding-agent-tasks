import test from 'node:test';
import assert from 'node:assert/strict';
import { expandSeries } from '../lib/expand.js';

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

const base = {
  tz: 'Asia/Shanghai',
  start: '2026-01-05T09:00:00',
  duration: 30,
  rule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3',
};

test('EXDATE 去掉一次，不把 COUNT 的名额吐回来', () => {
  const out = expandSeries({ ...base, exdates: ['2026-01-12T09:00:00'] });
  assert.deepEqual(
    out.map((item) => item.localDate),
    ['2026-01-05', '2026-01-19'],
  );
});

test('RDATE 加一次，排完序序号从头连着排', () => {
  const out = expandSeries({
    ...base,
    rule: 'FREQ=DAILY;COUNT=2',
    rdates: ['2026-01-20T09:00:00'],
  });
  assert.deepEqual(
    out.map((item) => item.localDate),
    ['2026-01-05', '2026-01-06', '2026-01-20'],
  );
  assert.deepEqual(out.map((item) => item.sequence), [1, 2, 3]);
});

test('改期的这次按新时间排，recurrenceId 还是原来那次', () => {
  const out = expandSeries({
    ...base,
    overrides: [{ at: '2026-01-12T09:00:00', start: '2026-01-13T15:00:00', duration: 45 }],
  });
  assert.deepEqual(
    out.map((item) => item.localDate),
    ['2026-01-05', '2026-01-13', '2026-01-19'],
  );
  assert.equal(out[1].recurrenceId, '2026-01-12T09:00:00');
  assert.equal(out[1].start, '2026-01-13T07:00:00Z');
  assert.equal(out[1].end, '2026-01-13T07:45:00Z');
  assert.equal(out[1].modified, true);
  assert.equal(out[0].modified, false);
});

test('改到更早的时间就排到前面去', () => {
  const out = expandSeries({
    ...base,
    overrides: [{ at: '2026-01-19T09:00:00', start: '2026-01-02T09:00:00' }],
  });
  assert.deepEqual(
    out.map((item) => item.localDate),
    ['2026-01-02', '2026-01-05', '2026-01-12'],
  );
  assert.equal(out[0].recurrenceId, '2026-01-19T09:00:00');
  assert.equal(out[0].sequence, 1);
  assert.equal(out[0].end, '2026-01-02T01:30:00Z');
});

test('取消的那次不产出，也不占序号', () => {
  const out = expandSeries({
    ...base,
    overrides: [{ at: '2026-01-12T09:00:00', cancelled: true }],
  });
  assert.deepEqual(
    out.map((item) => item.localDate),
    ['2026-01-05', '2026-01-19'],
  );
  assert.deepEqual(out.map((item) => item.sequence), [1, 2]);
});

test('override 得对得上某一次，对不上就报错', () => {
  expectError(
    () => expandSeries({ ...base, overrides: [{ at: '2026-01-06T09:00:00', cancelled: true }] }),
    'ERR_BAD_OVERRIDE',
  );
});

test('override 落在被 EXDATE 去掉的那次上也算数', () => {
  const out = expandSeries({
    ...base,
    exdates: ['2026-01-12T09:00:00'],
    overrides: [{ at: '2026-01-12T09:00:00', cancelled: true }],
  });
  assert.deepEqual(
    out.map((item) => item.localDate),
    ['2026-01-05', '2026-01-19'],
  );
});
