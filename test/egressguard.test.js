import assert from 'node:assert/strict';
import test from 'node:test';

import { ErrorKind, Reason } from '../src/errors.js';
import { release, setUp, tick } from './support/harness.js';

const ok = { status: 200, body: '{"ok":true}' };
const busy = { status: 503, body: '{"error":"busy"}' };

// 等一个"本来就该失败"的调用，拿到它抛出来的错误。
async function rejected(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: '这个调用本来应该失败的，结果成功了' });
}

const get = (upstream) => ({ upstream, method: 'GET', url: `http://up/${upstream}` });

test('一次就成：只发一次尝试，不重试', async () => {
  const { guard, counters, upstream } = setUp({ plan: { quota: [ok] } });

  const result = await guard.call(get('quota'));

  assert.equal(result.status, 200);
  assert.equal(result.attempts, 1);
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].timeoutMs, 200);
  const snapshot = counters.snapshot();
  assert.equal(snapshot.egress_calls_total, 1);
  assert.equal(snapshot.egress_attempts_total, 1);
  assert.equal(snapshot.egress_retries_total, 0);
});

test('5xx 会重试，退避按公式再加抖动', async () => {
  const { guard, counters, clock, upstream } = setUp({
    config: { backoff: { baseMs: 100, factor: 2, maxMs: 400, jitterMs: 40 } },
    random: () => 0.5,
    plan: { quota: [busy, ok] },
  });

  const result = await guard.call(get('quota'));

  assert.equal(result.status, 200);
  assert.equal(result.attempts, 2);
  assert.deepEqual(clock.sleeps, [120]); // 100 * 2^0 + 0.5 * 40
  assert.equal(upstream.calls[1].at, clock.start + 120); // 等完了才发第二次
  assert.equal(upstream.calls[1].timeoutMs, 200);
  assert.equal(counters.snapshot().egress_retries_total, 1);
});

test('连不上会重试，重试次数用完就以 connect 失败', async () => {
  const { guard, counters, upstream } = setUp({
    config: { maxAttempts: 3, backoff: { baseMs: 10, factor: 2, maxMs: 40, jitterMs: 0 } },
    plan: { quota: [{ connect: true }] },
  });

  const error = await rejected(guard.call(get('quota')));

  assert.equal(error.kind, ErrorKind.CONNECT);
  assert.equal(error.reason, Reason.MAX_ATTEMPTS);
  assert.equal(error.attempts, 3);
  assert.equal(upstream.calls.length, 3);
  assert.equal(counters.snapshot().egress_retries_total, 2);
});

test('上游明确说不行（4xx）就直接回给调用方，不重试也不算失败样本', async () => {
  const { guard, counters, upstream } = setUp({
    config: { breaker: { windowSize: 2, minSamples: 2, failureRatio: 0.5 } },
    plan: { quota: [{ status: 404, body: 'nope' }] },
  });

  for (let i = 0; i < 3; i += 1) {
    const result = await guard.call(get('quota'));
    assert.equal(result.status, 404);
    assert.equal(result.attempts, 1);
  }

  assert.equal(upstream.calls.length, 3); // 三次都是真发出去的，一次都没重试
  assert.equal(guard.snapshot().upstreams.quota.state, 'closed');
  assert.equal(counters.snapshot().egress_breaker_rejected_total, 0);
});

test('失败的响应里不值得重试的那种（500）当场失败', async () => {
  const { guard, upstream } = setUp({ plan: { profile: [{ status: 500, body: 'boom' }] } });

  const error = await rejected(guard.call(get('profile')));

  assert.equal(error.kind, ErrorKind.STATUS);
  assert.equal(error.status, 500);
  assert.equal(error.reason, Reason.NON_RETRYABLE);
  assert.equal(error.attempts, 1);
  assert.equal(upstream.calls.length, 1);
});

test('非幂等方法默认不重试，标了 idempotent 才重试', async () => {
  const { guard, upstream } = setUp({ plan: { quota: [busy, busy, ok] } });

  const error = await rejected(
    guard.call({ upstream: 'quota', method: 'POST', url: 'http://up/quota', body: 'x' }),
  );
  assert.equal(error.kind, ErrorKind.STATUS);
  assert.equal(error.reason, Reason.NON_RETRYABLE);
  assert.equal(upstream.calls.length, 1);

  const result = await guard.call({
    upstream: 'quota',
    method: 'POST',
    url: 'http://up/quota',
    body: 'x',
    idempotent: true,
  });
  assert.equal(result.status, 200);
  assert.equal(result.attempts, 2);
  assert.equal(upstream.calls.length, 3);
});

test('预算不够就不再发新尝试，单次尝试的超时也不会超过剩余预算', async () => {
  const { guard, counters, clock, upstream } = setUp({
    config: {
      budgetMs: 350,
      attemptTimeoutMs: 200,
      minAttemptRatio: 0.5,
      maxAttempts: 10,
      backoff: { baseMs: 0, factor: 2, maxMs: 0, jitterMs: 0 },
    },
    plan: { quota: [{ timeout: true }] },
  });

  const error = await rejected(guard.call(get('quota')));

  assert.equal(error.kind, ErrorKind.TIMEOUT);
  assert.equal(error.reason, Reason.BUDGET_EXHAUSTED);
  assert.equal(error.attempts, 2);
  assert.equal(upstream.calls.length, 2);
  assert.equal(upstream.calls[0].timeoutMs, 200);
  assert.equal(upstream.calls[1].timeoutMs, 150); // min(200, 只剩 150)
  assert.equal(clock.now() - clock.start, 350);
  const snapshot = counters.snapshot();
  assert.equal(snapshot.egress_attempts_total, 2);
  assert.equal(snapshot.egress_budget_exhausted_total, 1);
});

test('Retry-After 认秒数：等完不够再跑一次就不等', async () => {
  const { guard, counters, clock, upstream } = setUp({
    config: { budgetMs: 5000, maxAttempts: 5, attemptTimeoutMs: 200 },
    plan: { geocode: [{ status: 429, headers: { 'retry-after': '2' }, body: 'limited' }] },
  });

  const error = await rejected(guard.call(get('geocode')));

  assert.equal(error.kind, ErrorKind.STATUS);
  assert.equal(error.status, 429);
  assert.equal(error.reason, Reason.RETRY_AFTER_EXHAUSTED);
  assert.equal(error.attempts, 3);
  assert.deepEqual(clock.sleeps, [2000, 2000]); // 第三次没等
  assert.equal(upstream.calls.length, 3);
  assert.equal(counters.snapshot().egress_retry_after_exhausted_total, 1);
});

test('Retry-After 认 HTTP-date', async () => {
  const { guard, clock } = setUp({
    config: { budgetMs: 5000, maxAttempts: 5, attemptTimeoutMs: 200 },
    plan: {
      geocode: [
        () => ({
          status: 429,
          headers: { 'retry-after': new Date(clock.now() + 2000).toUTCString() },
          body: 'limited',
        }),
      ],
    },
  });

  const error = await rejected(guard.call(get('geocode')));

  assert.equal(error.reason, Reason.RETRY_AFTER_EXHAUSTED);
  assert.deepEqual(clock.sleeps, [2000, 2000]);
});

test('熔断：打开后快速失败，冷却到点进半开，探测够了才关闭', async () => {
  const { guard, counters, clock, upstream } = setUp({
    config: {
      maxAttempts: 1,
      breaker: {
        windowSize: 4,
        minSamples: 4,
        failureRatio: 0.5,
        cooldownMs: 1000,
        openBackoffFactor: 2,
        cooldownMaxMs: 8000,
        probeConcurrency: 1,
        probeSuccesses: 2,
      },
    },
    plan: { profile: [busy, busy, busy, busy, ok, ok] },
  });

  for (let i = 0; i < 4; i += 1) {
    assert.equal((await rejected(guard.call(get('profile')))).kind, ErrorKind.STATUS);
  }
  assert.equal(guard.snapshot().upstreams.profile.state, 'open');

  const blocked = await rejected(guard.call(get('profile')));
  assert.equal(blocked.kind, ErrorKind.BREAKER);
  assert.equal(blocked.reason, Reason.BREAKER_OPEN);
  assert.equal(blocked.attempts, 0);
  assert.equal(upstream.calls.length, 4); // 被挡下的那次没有真发
  assert.equal(counters.snapshot().egress_breaker_rejected_total, 1);

  clock.advance(999);
  assert.equal((await rejected(guard.call(get('profile')))).kind, ErrorKind.BREAKER);
  clock.advance(1);
  assert.equal((await guard.call(get('profile'))).status, 200); // 第一个探测
  assert.equal(guard.snapshot().upstreams.profile.state, 'half-open');
  assert.equal((await guard.call(get('profile'))).status, 200); // 第二个探测，够了
  assert.equal(guard.snapshot().upstreams.profile.state, 'closed');
  assert.equal(upstream.calls.length, 6);
});

test('半开探测失败就重新打开，冷却时间按连续打开次数翻倍', async () => {
  const { guard, clock, upstream } = setUp({
    config: {
      maxAttempts: 1,
      breaker: {
        windowSize: 1,
        minSamples: 1,
        failureRatio: 1,
        cooldownMs: 1000,
        openBackoffFactor: 2,
        cooldownMaxMs: 8000,
        probeConcurrency: 1,
        probeSuccesses: 1,
      },
    },
    plan: { profile: [busy, busy, ok] },
  });

  await rejected(guard.call(get('profile'))); // 打开，冷却 1000
  clock.advance(1000);
  const probe = await rejected(guard.call(get('profile'))); // 半开探测也失败
  assert.equal(probe.status, 503);
  assert.equal(guard.snapshot().upstreams.profile.state, 'open');

  assert.equal((await rejected(guard.call(get('profile')))).kind, ErrorKind.BREAKER);
  clock.advance(1000);
  assert.equal((await rejected(guard.call(get('profile')))).kind, ErrorKind.BREAKER); // 才过 1000，不够
  clock.advance(1000);
  assert.equal((await guard.call(get('profile'))).status, 200); // 冷却 2000 到了
  assert.equal(guard.snapshot().upstreams.profile.state, 'closed');
  assert.equal(upstream.calls.length, 3);
});

test('半开期间只放 probeConcurrency 个探测进去', async () => {
  let release_ = () => {};
  const hanging = new Promise((resolve) => {
    release_ = resolve;
  });
  const { guard, clock, upstream } = setUp({
    config: {
      maxAttempts: 1,
      breaker: {
        windowSize: 1,
        minSamples: 1,
        failureRatio: 1,
        cooldownMs: 1000,
        openBackoffFactor: 2,
        cooldownMaxMs: 8000,
        probeConcurrency: 1,
        probeSuccesses: 1,
      },
    },
    plan: { profile: [busy, { promise: hanging }, ok] },
  });

  await rejected(guard.call(get('profile')));
  clock.advance(1000);
  const probing = guard.call(get('profile')); // 挂住，占住探测名额
  await tick();

  const blocked = await rejected(guard.call(get('profile')));
  assert.equal(blocked.kind, ErrorKind.BREAKER);
  assert.equal(blocked.reason, Reason.BREAKER_OPEN);

  release_(release({ status: 200 }));
  assert.equal((await probing).status, 200);
  assert.equal(upstream.calls.length, 2);
  assert.equal(guard.snapshot().upstreams.profile.state, 'closed');
});

test('同一个上游的在飞数有上限，队列排不下就直接失败', async () => {
  let release_ = () => {};
  const hanging = new Promise((resolve) => {
    release_ = resolve;
  });
  const { guard, counters, upstream } = setUp({
    config: { maxAttempts: 1, bulkhead: { maxConcurrency: 1, queueLimit: 1 } },
    plan: { quota: [{ promise: hanging }, ok] },
  });

  const first = guard.call(get('quota'));
  await tick();
  assert.equal(guard.snapshot().upstreams.quota.inFlight, 1);
  assert.equal(guard.snapshot().upstreams.quota.queued, 0);

  const second = guard.call(get('quota'));
  await tick();
  assert.equal(guard.snapshot().upstreams.quota.queued, 1);

  const overflow = await rejected(guard.call(get('quota')));
  assert.equal(overflow.kind, ErrorKind.QUEUE);
  assert.equal(overflow.reason, Reason.QUEUE_FULL);

  release_(release({ status: 200 }));
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(upstream.calls.length, 2); // 排在后面的那个也真的发出去了
  const snapshot = counters.snapshot();
  assert.equal(snapshot.egress_queue_waited_total, 1);
  assert.equal(snapshot.egress_queue_full_total, 1);
  assert.equal(guard.snapshot().upstreams.quota.inFlight, 0);
  assert.equal(guard.snapshot().upstreams.quota.queued, 0);
});

test('排队也吃预算：等太久就按预算耗尽失败，而且一次都不发', async () => {
  let release_ = () => {};
  const hanging = new Promise((resolve) => {
    release_ = resolve;
  });
  const { guard, counters, clock, upstream } = setUp({
    config: {
      budgetMs: 300,
      attemptTimeoutMs: 200,
      minAttemptRatio: 0.5,
      maxAttempts: 1,
      bulkhead: { maxConcurrency: 1, queueLimit: 4 },
    },
    plan: { quota: [{ promise: hanging }, ok] },
  });

  const first = guard.call(get('quota'));
  await tick();
  const second = guard.call(get('quota'));
  await tick();
  assert.equal(guard.snapshot().upstreams.quota.queued, 1);

  clock.advance(250);
  release_(release({ status: 200 }));
  assert.equal((await first).status, 200);

  const error = await rejected(second);
  assert.equal(error.kind, ErrorKind.BUDGET);
  assert.equal(error.reason, Reason.BUDGET_EXHAUSTED);
  assert.equal(error.attempts, 0);
  assert.equal(upstream.calls.length, 1);
  assert.equal(counters.snapshot().egress_budget_exhausted_total, 1);
  assert.equal(guard.snapshot().upstreams.quota.inFlight, 0);
  assert.equal(guard.snapshot().upstreams.quota.queued, 0);
});

test('snapshot 给出每个上游的状态、在飞数、排队数和计数', async () => {
  const { guard, counters } = setUp({ plan: { quota: [ok], profile: [busy, ok] } });

  await guard.call(get('quota'));
  await guard.call(get('profile'));

  const snapshot = guard.snapshot();
  assert.deepEqual(Object.keys(snapshot.upstreams).sort(), ['profile', 'quota']);
  assert.equal(snapshot.upstreams.quota.state, 'closed');
  assert.equal(snapshot.upstreams.quota.inFlight, 0);
  assert.equal(snapshot.upstreams.quota.queued, 0);
  assert.equal(snapshot.counters.egress_calls_total, 2);
  assert.equal(snapshot.counters.egress_attempts_total, 3);
  assert.deepEqual(snapshot.counters, counters.snapshot());
});
