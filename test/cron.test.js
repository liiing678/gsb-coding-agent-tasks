import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../lib/scheduler.js';

const at = (iso) => Date.parse(iso);

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'SchedulerError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

function hits(cron, from, to, id = 'job') {
  const scheduler = createScheduler({ clock: () => at(to) });
  scheduler.defineJob({ id, cron });
  return scheduler.plan({ from: at(from), to: at(to) })
    .map((one) => new Date(one.at).toISOString().slice(11, 16));
}

test('每分钟一次，from 不在整分钟上就从下一个整分开始', () => {
  assert.deepEqual(hits('* * * * *', '2026-03-01T00:00:00Z', '2026-03-01T00:03:00Z'),
    ['00:00', '00:01', '00:02']);

  const scheduler = createScheduler();
  scheduler.defineJob({ id: 'job', cron: '* * * * *' });
  const planned = scheduler.plan({ from: at('2026-03-01T00:00:30Z'), to: at('2026-03-01T00:03:00Z') });
  assert.deepEqual(planned.map((one) => one.at - at('2026-03-01T00:00:30Z')), [30000, 90000]);
  assert.equal(planned[0].id, 'job@2026-03-01T00:01Z');
});

test('范围加步长', () => {
  assert.deepEqual(hits('*/15 9-10 * * *', '2026-03-01T00:00:00Z', '2026-03-01T12:00:00Z'), [
    '09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '10:30', '10:45',
  ]);
  assert.deepEqual(hits('5-25/10 * * * *', '2026-03-01T03:00:00Z', '2026-03-01T05:00:00Z'), [
    '03:05', '03:15', '03:25', '04:05', '04:15', '04:25',
  ]);
  assert.deepEqual(hits('0,30 8 * * *', '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z'),
    ['08:00', '08:30']);
});

test('日和周都被限定时取并集', () => {
  // 2026-03-01 是周日：这一天两个条件都命中，3-08 只有周日命中（要是写成 AND 就只有 3-01 一天）
  const scheduler = createScheduler();
  scheduler.defineJob({ id: 'job', cron: '0 0 1 * 0' });
  const planned = scheduler.plan({ from: at('2026-03-01T00:00:00Z'), to: at('2026-03-09T00:00:00Z') });
  assert.deepEqual(planned.map((one) => new Date(one.at).toISOString().slice(0, 10)),
    ['2026-03-01', '2026-03-08']);
});

test('周一格 7 就是 0（周日）', () => {
  const scheduler = createScheduler();
  scheduler.defineJob({ id: 'weekday', cron: '0 0 * * 7' });
  assert.deepEqual(
    scheduler.plan({ from: at('2026-03-01T00:00:00Z'), to: at('2026-03-09T00:00:00Z') })
      .map((one) => new Date(one.at).toISOString().slice(0, 10)),
    ['2026-03-01', '2026-03-08']);
  assert.deepEqual(hits('0 0 * * 1', '2026-03-01T00:00:00Z', '2026-03-09T00:00:00Z'), ['00:00']);
});

test('非法 cron 报 ERR_BAD_CRON', () => {
  const scheduler = createScheduler();
  for (const cron of ['* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *',
    '* * * 13 *', '* * * * 8', '5-1 * * * *', '* * * * 1-2-3', '*/0 * * * *', '*/x * * * *',
    '1,,2 * * * *', '', 'a * * * *']) {
    expectError(() => scheduler.defineJob({ id: 'job', cron }), 'ERR_BAD_CRON');
  }
  expectError(() => scheduler.defineJob({ id: 'job', cron: 42 }), 'ERR_BAD_CRON');
});
