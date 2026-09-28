import test from 'node:test';
import assert from 'node:assert/strict';
import { expandSeries } from '../lib/expand.js';

test('跨春季跳表，本地钟点还是 09:00，时刻差一小时', () => {
  const out = expandSeries({
    tz: 'America/New_York',
    start: '2026-03-01T09:00:00',
    duration: 60,
    rule: 'FREQ=WEEKLY;BYDAY=SU;COUNT=3',
  });
  assert.deepEqual(out.map((item) => item.localDate), ['2026-03-01', '2026-03-08', '2026-03-15']);
  assert.deepEqual(out.map((item) => item.localTime), ['09:00:00', '09:00:00', '09:00:00']);
  assert.deepEqual(out.map((item) => item.start), [
    '2026-03-01T14:00:00Z',
    '2026-03-08T13:00:00Z',
    '2026-03-15T13:00:00Z',
  ]);
  assert.deepEqual(out.map((item) => item.offsetMinutes), [-300, -240, -240]);
  assert.deepEqual(out.map((item) => item.kind), ['exact', 'exact', 'exact']);
});

test('落在春季跳表空档里的墙钟：按跳表之后的偏移往后挪', () => {
  const out = expandSeries({
    tz: 'America/New_York',
    start: '2026-01-01T02:30:00',
    duration: 30,
    rule: 'FREQ=YEARLY;BYMONTH=3;BYDAY=2SU;COUNT=1',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].localDate, '2026-03-08');
  assert.equal(out[0].localTime, '02:30:00');
  assert.equal(out[0].kind, 'gap');
  assert.equal(out[0].offsetMinutes, -240);
  assert.equal(out[0].start, '2026-03-08T06:30:00Z');
  assert.equal(out[0].end, '2026-03-08T07:00:00Z');
});

test('秋季回拨重复的那一小时：取先发生的那次', () => {
  const out = expandSeries({
    tz: 'America/New_York',
    start: '2026-10-31T01:30:00',
    duration: 30,
    rule: 'FREQ=DAILY;COUNT=3',
  });
  assert.deepEqual(out.map((item) => item.localTime), ['01:30:00', '01:30:00', '01:30:00']);
  assert.deepEqual(out.map((item) => item.start), [
    '2026-10-31T05:30:00Z',
    '2026-11-01T05:30:00Z',
    '2026-11-02T06:30:00Z',
  ]);
  assert.deepEqual(out.map((item) => item.kind), ['exact', 'ambiguous', 'exact']);
  assert.deepEqual(out.map((item) => item.offsetMinutes), [-240, -240, -300]);
});

test('时区跟着规则走，同一个墙钟在不同时区不是同一时刻', () => {
  const shanghai = expandSeries({
    tz: 'Asia/Shanghai',
    start: '2026-06-01T09:00:00',
    duration: 0,
    rule: 'FREQ=DAILY;COUNT=1',
  });
  const berlin = expandSeries({
    tz: 'Europe/Berlin',
    start: '2026-06-01T09:00:00',
    duration: 0,
    rule: 'FREQ=DAILY;COUNT=1',
  });
  assert.equal(shanghai[0].start, '2026-06-01T01:00:00Z');
  assert.equal(berlin[0].start, '2026-06-01T07:00:00Z');
  assert.equal(berlin[0].offsetMinutes, 120);
});
