import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../lib/scheduler.js';

const at = (iso) => Date.parse(iso);
const FROM = at('2026-03-01T00:00:00Z');
const TO = at('2026-03-01T00:06:00Z');

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

function build() {
  const scheduler = createScheduler({ clock: () => TO });
  scheduler.defineJob({ id: 'tick', cron: '* * * * *' });
  scheduler.defineJob({ id: 'rollup', cron: '*/5 * * * *', dependsOn: ['tick'], retries: 1, backoffMs: 30000 });
  scheduler.defineJob({ id: 'digest', cron: '* * * * *', dependsOn: ['rollup'] });
  return scheduler;
}

const label = (id) => `${id.slice(0, id.indexOf('@'))}@${new Date(Date.parse(id.slice(id.indexOf('@') + 1))).toISOString().slice(11, 16)}`;

test('plan 按时刻排序，依赖指到窗口里最近的一次上游', () => {
  const scheduler = build();
  const planned = scheduler.plan({ from: FROM, to: TO });
  assert.deepEqual(planned.map((one) => label(one.id)), [
    'tick@00:00', 'rollup@00:00', 'digest@00:00',
    'tick@00:01', 'digest@00:01',
    'tick@00:02', 'digest@00:02',
    'tick@00:03', 'digest@00:03',
    'tick@00:04', 'digest@00:04',
    'tick@00:05', 'rollup@00:05', 'digest@00:05',
  ]);
  assert.equal(planned.find((one) => one.jobId === 'digest').level, 2, 'digest 在链上是第三层');
  const lastDigest = planned.find((one) => one.id === 'digest@2026-03-01T00:05Z');
  assert.deepEqual(lastDigest.dependsOn.map(label), ['rollup@00:05']);
  assert.equal(lastDigest.skipped, null);
  const firstTick = planned.find((one) => one.id === 'tick@2026-03-01T00:00Z');
  assert.deepEqual(firstTick.dependsOn, []);
  assert.equal(firstTick.level, 0);
});

test('窗口里没有更早的上游，这次就标成 NO_UPSTREAM', () => {
  const scheduler = createScheduler();
  scheduler.defineJob({ id: 'later', cron: '2 * * * *' });
  scheduler.defineJob({ id: 'every', cron: '* * * * *', dependsOn: ['later'] });
  const planned = scheduler.plan({ from: FROM, to: TO });
  const every = planned.filter((one) => one.jobId === 'every');
  assert.equal(every[0].id, 'every@2026-03-01T00:00Z');
  assert.deepEqual(every[0].dependsOn, [], '00:00 之前上游一次都没跑过');
  assert.equal(every[0].skipped, 'NO_UPSTREAM');
  assert.equal(every[1].skipped, 'NO_UPSTREAM');
  assert.equal(every[2].skipped, null);
  assert.deepEqual(every[2].dependsOn, ['later@2026-03-01T00:02Z'], '同一条分钟上也算数');
  assert.deepEqual(every[5].dependsOn, ['later@2026-03-01T00:02Z']);

  const { runs } = scheduler.execute({ from: FROM, to: TO, perform: () => 'ok' });
  assert.equal(runs.find((one) => one.id === 'every@2026-03-01T00:00Z').status, 'skipped');
  assert.equal(runs.find((one) => one.id === 'every@2026-03-01T00:00Z').reason, 'NO_UPSTREAM');
  assert.equal(runs.find((one) => one.id === 'every@2026-03-01T00:02Z').status, 'ok');
});

test('任务定义的错误码', () => {
  const scheduler = build();
  expectError(() => scheduler.defineJob({ id: 'rollup', cron: '* * * * *' }), 'ERR_BAD_JOB');
  expectError(() => scheduler.defineJob({ id: '', cron: '* * * * *' }), 'ERR_BAD_JOB');
  expectError(() => scheduler.defineJob({ id: 'x', cron: '* * * * *', retries: -1 }), 'ERR_BAD_JOB');
  expectError(() => scheduler.defineJob({ id: 'x', cron: '* * * * *', backoffMs: 0 }), 'ERR_BAD_JOB');
  expectError(() => scheduler.defineJob({ id: 'x', cron: '* * * * *', dependsOn: ['tick', 'tick'] }), 'ERR_BAD_JOB');
  expectError(() => scheduler.defineJob(null), 'ERR_BAD_JOB');
  expectError(() => scheduler.defineJob({ id: 'x', cron: '* * * * *', dependsOn: ['nope'] }), 'ERR_UNKNOWN_DEP');
  expectError(() => scheduler.defineJob({ id: 'self', cron: '* * * * *', dependsOn: ['self'] }), 'ERR_CYCLE');
  expectError(() => createScheduler({ clock: 1 }), 'ERR_BAD_CONFIG');
  expectError(() => createScheduler(null), 'ERR_BAD_CONFIG');
});

test('retry 退避重排，用完了才判失败', () => {
  const scheduler = build();
  const seen = [];
  const { runs } = scheduler.execute({
    from: FROM,
    to: TO,
    perform: (run) => {
      seen.push(`${run.jobId}@${run.attempt}`);
      return run.jobId === 'rollup' && run.at === at('2026-03-01T00:05:00Z') ? 'retry' : 'ok';
    },
  });
  const failed = runs.find((one) => one.id === 'rollup@2026-03-01T00:05Z');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'RETRIES_EXHAUSTED');
  assert.equal(failed.attempts, 2);
  assert.deepEqual(failed.retryAts.map((one) => one - failed.at), [30000]);
  assert.ok(seen.includes('rollup@1') && seen.includes('rollup@2'));
  assert.equal(scheduler.stats().retries, 1);
});

test('fail 不重试，下游跟着跳过', () => {
  const scheduler = build();
  const { runs, stats } = scheduler.execute({
    from: FROM,
    to: TO,
    perform: (run) => (run.jobId === 'rollup' && run.at === at('2026-03-01T00:05:00Z') ? 'fail' : 'ok'),
  });
  const failed = runs.find((one) => one.id === 'rollup@2026-03-01T00:05Z');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'FAILED');
  assert.equal(failed.attempts, 1);
  assert.deepEqual(failed.retryAts, []);

  const skipped = runs.find((one) => one.id === 'digest@2026-03-01T00:05Z');
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.reason, 'UPSTREAM_FAILED');
  assert.equal(skipped.attempts, 0);
  assert.equal(stats.ok, 12);
  assert.equal(stats.failed, 1);
  assert.equal(stats.skipped, 1);
});

test('上游自己就是跳过的，下游报 UPSTREAM_SKIPPED', () => {
  const scheduler = createScheduler();
  scheduler.defineJob({ id: 'later', cron: '2 * * * *' });
  scheduler.defineJob({ id: 'mid', cron: '* * * * *', dependsOn: ['later'] });
  scheduler.defineJob({ id: 'leaf', cron: '* * * * *', dependsOn: ['mid'] });
  const { runs } = scheduler.execute({ from: FROM, to: TO, perform: () => 'ok' });
  const first = runs.find((one) => one.id === 'mid@2026-03-01T00:01Z');
  assert.equal(first.status, 'skipped');
  assert.equal(first.reason, 'NO_UPSTREAM');
  const leaf = runs.find((one) => one.id === 'leaf@2026-03-01T00:01Z');
  assert.equal(leaf.status, 'skipped');
  assert.equal(leaf.reason, 'UPSTREAM_SKIPPED');
  assert.equal(runs.find((one) => one.id === 'mid@2026-03-01T00:05Z').status, 'ok');
  assert.equal(runs.find((one) => one.id === 'leaf@2026-03-01T00:05Z').status, 'ok');
});

test('周期和 perform 的参数校验', () => {
  const scheduler = build();
  expectError(() => scheduler.plan({ from: TO, to: FROM }), 'ERR_BAD_PERIOD');
  expectError(() => scheduler.plan({ from: 'now' }), 'ERR_BAD_PERIOD');
  expectError(() => scheduler.plan({ from: FROM, to: Number.NaN }), 'ERR_BAD_PERIOD');
  expectError(() => scheduler.execute({ from: FROM, to: TO }), 'ERR_BAD_PERFORM');
  expectError(() => scheduler.execute({ from: FROM, to: TO, perform: () => 'maybe' }), 'ERR_BAD_PERFORM');
});

test('统计：任务数、最长链、累计计数', () => {
  const scheduler = build();
  assert.deepEqual(scheduler.stats(), {
    jobs: 3, longestChain: 3, planned: 0, ok: 0, failed: 0, skipped: 0, retries: 0,
  });
  scheduler.plan({ from: FROM, to: TO });
  const { stats } = scheduler.execute({ from: FROM, to: TO, perform: () => 'retry' });
  assert.equal(stats.planned, 14, 'execute 自己展开的那轮不算进 planned');
  assert.equal(stats.ok, 0);
  assert.equal(stats.failed, 6, 'tick 没有重试额度，每次 retry 直接算失败');
  assert.equal(stats.skipped, 8, 'rollup 和 digest 都挂在上游失败上');
  assert.equal(stats.retries, 0, '被跳过的任务根本没调 perform');
  assert.deepEqual(scheduler.jobs.map((one) => one.level), [0, 1, 2]);
});
