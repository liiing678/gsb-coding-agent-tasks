import assert from 'node:assert/strict';
import test from 'node:test';

import { createCounters } from '../lib/counters.js';
import { CronParseError, SchedulerStateError } from '../lib/errors.js';
import { createManualClock } from '../lib/manual-clock.js';
import { createScheduler, parseCron } from '../lib/scheduler.js';

const NY = 'America/New_York';

async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function setUp({ timeZone = 'UTC' } = {}) {
  const clock = createManualClock(Date.UTC(2026, 0, 1, 0, 0));
  const counters = createCounters();
  const scheduler = createScheduler({ config: { timeZone }, counters, now: clock.now, sleep: clock.sleep });
  return { scheduler, counters, clock };
}

test('每 15 分钟那种：next 一步一步往后算', () => {
  const cron = parseCron('*/15 * * * *', 'UTC');
  let at = Date.UTC(2026, 0, 1, 0, 7);
  const hits = [];
  for (let i = 0; i < 4; i += 1) {
    at = cron.next(at);
    hits.push(at);
  }
  assert.deepEqual(hits, [
    Date.UTC(2026, 0, 1, 0, 15),
    Date.UTC(2026, 0, 1, 0, 30),
    Date.UTC(2026, 0, 1, 0, 45),
    Date.UTC(2026, 0, 1, 1, 0),
  ]);
});

test('列表、范围、步长凑一起也认得', () => {
  const cron = parseCron('0,30 9-17 * * 1-5', 'UTC');
  const first = cron.next(Date.UTC(2026, 0, 3, 12, 0)); // 周六
  assert.equal(first, Date.UTC(2026, 0, 5, 9, 0)); // 周一 09:00
  assert.equal(cron.next(first), Date.UTC(2026, 0, 5, 9, 30));
  assert.equal(cron.next(Date.UTC(2026, 0, 5, 17, 30)), Date.UTC(2026, 0, 6, 9, 0));
  assert.equal(cron.next(Date.UTC(2026, 0, 9, 18, 0)), Date.UTC(2026, 0, 12, 9, 0));
});

test('日和星期都写死的时候，按"或"来', () => {
  const cron = parseCron('0 0 1 * 1', 'UTC');
  let at = Date.UTC(2026, 0, 1, 0, 0);
  const hits = [];
  for (let i = 0; i < 5; i += 1) {
    at = cron.next(at);
    hits.push(at);
  }
  assert.deepEqual(hits, [
    Date.UTC(2026, 0, 5, 0, 0),
    Date.UTC(2026, 0, 12, 0, 0),
    Date.UTC(2026, 0, 19, 0, 0),
    Date.UTC(2026, 0, 26, 0, 0),
    Date.UTC(2026, 1, 1, 0, 0),
  ]);
});

test('写错的 cron 抛 CronParseError', () => {
  const bad = [
    '60 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * * 13 *',
    '* * * * 8',
    '*/0 * * * *',
    'a * * * *',
    '* * * *',
    '* * * * * *',
  ];
  for (const expression of bad) {
    assert.throws(() => parseCron(expression, 'UTC'), CronParseError, expression);
  }
  assert.throws(() => parseCron('* * * * *', 'Mars/Olympus'), CronParseError);
});

test('时区里的 09:00 得换算过去', () => {
  const cron = parseCron('0 9 * * *', NY);
  assert.equal(cron.next(Date.UTC(2026, 2, 6, 0, 0)), Date.UTC(2026, 2, 6, 14, 0)); // 冬令时
  assert.equal(cron.next(Date.UTC(2026, 2, 9, 0, 0)), Date.UTC(2026, 2, 9, 13, 0)); // 夏令时
});

test('夏令时跳表：本地 02:30 那天不存在，顺延到 03:00 跑一次', () => {
  const cron = parseCron('30 2 * * *', NY);
  const first = cron.next(Date.UTC(2026, 2, 8, 0, 0));
  assert.equal(first, Date.UTC(2026, 2, 8, 7, 0));
  assert.equal(cron.next(first), Date.UTC(2026, 2, 9, 6, 30));
});

test('夏令时回拨：本地 01:30 出现两次，只在第一次跑', () => {
  const cron = parseCron('30 1 * * *', NY);
  const first = cron.next(Date.UTC(2026, 10, 1, 0, 0));
  assert.equal(first, Date.UTC(2026, 10, 1, 5, 30));
  assert.equal(cron.next(first), Date.UTC(2026, 10, 2, 6, 30));
});

test('到点就按各自的时间跑，互不影响', async () => {
  const { scheduler, clock } = setUp();
  const every10 = [];
  const hourly = [];
  scheduler.add({ name: 'every10', cron: '*/10 * * * *', run: (at) => every10.push(at) });
  scheduler.add({ name: 'hourly', cron: '0 * * * *', run: (at) => hourly.push(at) });
  scheduler.start();

  await clock.advance(3600000);
  await flush();

  assert.deepEqual(every10, [
    Date.UTC(2026, 0, 1, 0, 10),
    Date.UTC(2026, 0, 1, 0, 20),
    Date.UTC(2026, 0, 1, 0, 30),
    Date.UTC(2026, 0, 1, 0, 40),
    Date.UTC(2026, 0, 1, 0, 50),
    Date.UTC(2026, 0, 1, 1, 0),
  ]);
  assert.deepEqual(hourly, [Date.UTC(2026, 0, 1, 1, 0)]);
  await scheduler.stop();
});

test('上一次还在跑，这一次就不开', async () => {
  const { scheduler, counters, clock } = setUp();
  let release;
  const fired = [];
  scheduler.add({
    name: 'slow',
    cron: '*/10 * * * *',
    run: (at) => {
      fired.push(at);
      if (fired.length === 1) {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return undefined;
    },
  });
  scheduler.start();

  await clock.advance(30 * 60000);
  await flush();
  assert.deepEqual(fired, [Date.UTC(2026, 0, 1, 0, 10)]);
  assert.equal(counters.snapshot().tickwheel_overlap_skipped_total, 2);

  await clock.advance(10 * 60000);
  await flush();
  assert.equal(counters.snapshot().tickwheel_overlap_skipped_total, 3);

  release();
  await flush();
  await clock.advance(10 * 60000);
  await flush();
  assert.deepEqual(fired, [Date.UTC(2026, 0, 1, 0, 10), Date.UTC(2026, 0, 1, 0, 50)]);
  assert.equal(counters.snapshot().tickwheel_fired_total, 2);
  await scheduler.stop();
});

test('run 抛错只管记一笔，后面的照跑', async () => {
  const { scheduler, counters, clock } = setUp();
  const fired = [];
  scheduler.add({
    name: 'boom',
    cron: '* * * * *',
    run: (at) => {
      fired.push(at);
      if (fired.length === 1) {
        throw new Error('这次不行');
      }
    },
  });
  scheduler.start();

  await clock.advance(3 * 60000);
  await flush();

  assert.equal(fired.length, 3);
  assert.equal(counters.snapshot().tickwheel_fired_total, 3);
  assert.equal(counters.snapshot().tickwheel_failed_total, 1);
  await scheduler.stop();
});

test('时钟被往回拨，同一个时间点也不会再跑一次', async () => {
  const { scheduler, clock } = setUp();
  const fired = [];
  scheduler.add({ name: 'every10', cron: '*/10 * * * *', run: (at) => fired.push(at) });
  scheduler.start();

  await clock.advance(10 * 60000);
  await flush();
  await clock.advance(-5 * 60000);
  await clock.advance(15 * 60000);
  await flush();

  assert.deepEqual(fired, [Date.UTC(2026, 0, 1, 0, 10), Date.UTC(2026, 0, 1, 0, 20)]);
  await scheduler.stop();
});

test('stop 之后不再开新的，在跑的等它跑完', async () => {
  const { scheduler, counters, clock } = setUp();
  let release;
  const fired = [];
  scheduler.add({
    name: 'slow',
    cron: '* * * * *',
    run: (at) => {
      fired.push(at);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  scheduler.start();
  await clock.advance(60000);
  await flush();

  const stopping = scheduler.stop();
  let done = false;
  stopping.then(() => {
    done = true;
  });
  await flush();
  assert.equal(done, false);
  assert.deepEqual(scheduler.stats().running, ['slow']);
  assert.equal(scheduler.stop(), stopping);

  release();
  await stopping;
  assert.equal(done, true);
  assert.deepEqual(scheduler.stats().running, []);

  await clock.advance(10 * 60000);
  await flush();
  assert.equal(fired.length, 1);
  assert.equal(counters.snapshot().tickwheel_fired_total, 1);
  assert.throws(() => scheduler.start(), SchedulerStateError);
});

test('用法不对的几种情况都抛 SchedulerStateError', () => {
  const { scheduler } = setUp();
  scheduler.add({ name: 'a', cron: '* * * * *', run: () => {} });
  assert.throws(() => scheduler.add({ name: 'a', cron: '* * * * *', run: () => {} }), SchedulerStateError);
  assert.throws(() => scheduler.add({ name: '', cron: '* * * * *', run: () => {} }), SchedulerStateError);
  assert.throws(() => scheduler.add({ name: 'b', cron: '* * * * *' }), SchedulerStateError);
  assert.throws(() => scheduler.add({ name: 'c', cron: 'nope', run: () => {} }), CronParseError);
  scheduler.start();
  assert.throws(() => scheduler.add({ name: 'd', cron: '* * * * *', run: () => {} }), SchedulerStateError);
});

test('stats 和计数器对得上', async () => {
  const { scheduler, counters, clock } = setUp({ timeZone: NY });
  scheduler.add({ name: 'a', cron: '0 9 * * *', run: () => {} });
  scheduler.add({ name: 'b', cron: '0 10 * * *', run: () => {} });

  const before = scheduler.stats();
  assert.equal(before.timeZone, NY);
  assert.deepEqual(before.jobs, ['a', 'b']);
  assert.deepEqual(before.running, []);
  assert.deepEqual(Object.keys(before.counters), counters.names);
  assert.equal(counters.names.length, 4);
  assert.equal(counters.snapshot().tickwheel_jobs_total, 2);

  scheduler.start();
  await clock.advance(15 * 3600000);
  await flush();
  assert.equal(counters.snapshot().tickwheel_fired_total, 2);
  await scheduler.stop();
});
