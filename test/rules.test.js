import test from 'node:test';
import assert from 'node:assert/strict';
import { expandSeries } from '../lib/expand.js';

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'CalError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

const dates = (out) => out.map((item) => item.start);
const locals = (out) => out.map((item) => `${item.localDate} ${item.localTime}`);

test('每天一次：本地钟点不变，按 UTC 换算出来', () => {
  const out = expandSeries({
    tz: 'Asia/Shanghai',
    start: '2026-01-05T09:00:00',
    duration: 30,
    rule: 'FREQ=DAILY;COUNT=5',
  });
  assert.deepEqual(dates(out), [
    '2026-01-05T01:00:00Z',
    '2026-01-06T01:00:00Z',
    '2026-01-07T01:00:00Z',
    '2026-01-08T01:00:00Z',
    '2026-01-09T01:00:00Z',
  ]);
  assert.deepEqual(out.map((item) => item.sequence), [1, 2, 3, 4, 5]);
  assert.equal(out[0].end, '2026-01-05T01:30:00Z');
  assert.equal(out[0].offsetMinutes, 480);
  assert.equal(out[0].kind, 'exact');
  assert.equal(out[0].modified, false);
});

test('每两周的周一和周三', () => {
  const out = expandSeries({
    tz: 'Asia/Shanghai',
    start: '2026-01-05T09:00:00',
    duration: 0,
    rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6',
  });
  assert.deepEqual(dates(out), [
    '2026-01-05T01:00:00Z',
    '2026-01-07T01:00:00Z',
    '2026-01-19T01:00:00Z',
    '2026-01-21T01:00:00Z',
    '2026-02-02T01:00:00Z',
    '2026-02-04T01:00:00Z',
  ]);
});

test('WKST 决定周怎么切，结果跟着变', () => {
  const base = {
    tz: 'Asia/Shanghai',
    start: '2026-01-07T09:00:00',
    duration: 0,
  };
  const sunday = expandSeries({
    ...base,
    rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,WE;WKST=SU;COUNT=4',
  });
  const monday = expandSeries({
    ...base,
    rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,WE;WKST=MO;COUNT=4',
  });
  assert.deepEqual(locals(sunday), [
    '2026-01-07 09:00:00',
    '2026-01-18 09:00:00',
    '2026-01-21 09:00:00',
    '2026-02-01 09:00:00',
  ]);
  assert.deepEqual(locals(monday), [
    '2026-01-07 09:00:00',
    '2026-01-11 09:00:00',
    '2026-01-21 09:00:00',
    '2026-01-25 09:00:00',
  ]);
});

test('每月 31 号：没有 31 号的月份直接跳过，不往后挪', () => {
  const out = expandSeries({
    tz: 'Asia/Shanghai',
    start: '2026-01-15T09:00:00',
    duration: 0,
    rule: 'FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4',
  });
  assert.deepEqual(
    out.map((item) => item.localDate),
    ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31'],
  );
});

test('每月最后一个周五', () => {
  const out = expandSeries({
    tz: 'Asia/Shanghai',
    start: '2026-01-15T09:00:00',
    duration: 0,
    rule: 'FREQ=MONTHLY;BYDAY=-1FR;COUNT=3',
  });
  assert.deepEqual(
    out.map((item) => item.localDate),
    ['2026-01-30', '2026-02-27', '2026-03-27'],
  );
});

test('BYSETPOS：每月最后一个工作日', () => {
  const out = expandSeries({
    tz: 'Asia/Shanghai',
    start: '2026-01-15T09:00:00',
    duration: 0,
    rule: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3',
  });
  assert.deepEqual(
    out.map((item) => item.localDate),
    ['2026-01-30', '2026-02-27', '2026-03-31'],
  );
});

test('UNTIL 是本地墙钟，含边界那次', () => {
  const out = expandSeries({
    tz: 'Asia/Shanghai',
    start: '2026-01-05T09:00:00',
    duration: 0,
    rule: 'FREQ=DAILY;UNTIL=2026-01-08T09:00:00',
  });
  assert.deepEqual(
    out.map((item) => item.localDate),
    ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'],
  );
});

test('时长按墙钟算，跨过午夜也对', () => {
  const out = expandSeries({
    tz: 'Asia/Shanghai',
    start: '2026-01-05T23:30:00',
    duration: 90,
    rule: 'FREQ=DAILY;COUNT=2',
  });
  assert.equal(out[0].start, '2026-01-05T15:30:00Z');
  assert.equal(out[0].end, '2026-01-05T17:00:00Z');
  assert.equal(out[1].start, '2026-01-06T15:30:00Z');
});

test('窗口只筛结果，不改变前面的序号来源', () => {
  const out = expandSeries(
    {
      tz: 'Asia/Shanghai',
      start: '2026-01-05T09:00:00',
      duration: 0,
      rule: 'FREQ=DAILY;COUNT=10',
    },
    { from: '2026-01-07T00:00:00Z', to: '2026-01-09T00:00:00Z' },
  );
  assert.deepEqual(dates(out), ['2026-01-07T01:00:00Z', '2026-01-08T01:00:00Z']);
  assert.deepEqual(out.map((item) => item.sequence), [1, 2]);
});

test('结果条数超过 limit 就报错', () => {
  expectError(
    () =>
      expandSeries(
        {
          tz: 'Asia/Shanghai',
          start: '2026-01-01T09:00:00',
          duration: 0,
          rule: 'FREQ=DAILY',
        },
        { to: '2026-02-01T00:00:00Z', limit: 5 },
      ),
    'ERR_LIMIT_EXCEEDED',
  );
});

test('一直展开不完也会被拦住', () => {
  expectError(
    () =>
      expandSeries(
        {
          tz: 'Asia/Shanghai',
          start: '2026-01-01T09:00:00',
          duration: 0,
          rule: 'FREQ=DAILY',
        },
        { maxIterations: 20 },
      ),
    'ERR_LIMIT_EXCEEDED',
  );
});

test('规则和时间的各种坏输入', () => {
  const base = { tz: 'Asia/Shanghai', start: '2026-01-05T09:00:00', duration: 0 };
  expectError(
    () => expandSeries({ ...base, rule: 'FREQ=HOURLY;COUNT=2' }),
    'ERR_UNSUPPORTED_RULE',
  );
  expectError(
    () => expandSeries({ ...base, rule: 'FREQ=DAILY;BYWEEKNO=1' }),
    'ERR_UNSUPPORTED_RULE',
  );
  expectError(
    () => expandSeries({ ...base, rule: 'FREQ=WEEKLY;BYSETPOS=1;BYDAY=MO' }),
    'ERR_UNSUPPORTED_RULE',
  );
  expectError(
    () => expandSeries({ ...base, rule: 'FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=1' }),
    'ERR_UNSUPPORTED_RULE',
  );
  expectError(
    () => expandSeries({ ...base, rule: 'FREQ=DAILY;COUNT=2;UNTIL=2026-01-08T09:00:00' }),
    'ERR_BAD_RULE',
  );
  expectError(() => expandSeries({ ...base, rule: 'INTERVAL=2' }), 'ERR_BAD_RULE');
  expectError(() => expandSeries({ ...base, rule: 'FREQ=DAILY;NOPE=1' }), 'ERR_BAD_RULE');
  expectError(
    () => expandSeries({ ...base, rule: 'FREQ=WEEKLY;BYDAY=2MO' }),
    'ERR_BAD_RULE',
  );
  expectError(
    () => expandSeries({ tz: 'Mars/Base', start: '2026-01-05T09:00:00', duration: 0, rule: 'FREQ=DAILY;COUNT=1' }),
    'ERR_BAD_TZ',
  );
  expectError(
    () => expandSeries({ ...base, start: '2026-01-05 09:00', rule: 'FREQ=DAILY;COUNT=1' }),
    'ERR_BAD_TIME',
  );
  expectError(
    () => expandSeries({ ...base, duration: -1, rule: 'FREQ=DAILY;COUNT=1' }),
    'ERR_BAD_SERIES',
  );
  expectError(
    () => expandSeries({ ...base, rule: 'FREQ=DAILY;COUNT=1' }, { from: '2026-01-07 00:00' }),
    'ERR_BAD_SERIES',
  );
});
