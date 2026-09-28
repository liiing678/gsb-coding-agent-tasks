import { createCounters } from '../../src/counters.js';
import { createGuard } from '../../src/guard.js';
import { createFakeClock } from './fake-clock.js';
import { createFakeUpstream } from './fake-upstream.js';

// 用例自己的配置：窗口、上限都调小了，跑得快。
export const BASE_CONFIG = {
  budgetMs: 1000,
  attemptTimeoutMs: 200,
  minAttemptRatio: 0.5,
  maxAttempts: 3,
  backoff: { baseMs: 100, factor: 2, maxMs: 400, jitterMs: 0 },
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
  bulkhead: { maxConcurrency: 2, queueLimit: 2 },
};

function mergeConfig(overrides = {}) {
  return {
    ...BASE_CONFIG,
    ...overrides,
    backoff: { ...BASE_CONFIG.backoff, ...(overrides.backoff ?? {}) },
    breaker: { ...BASE_CONFIG.breaker, ...(overrides.breaker ?? {}) },
    bulkhead: { ...BASE_CONFIG.bulkhead, ...(overrides.bulkhead ?? {}) },
  };
}

export function setUp({ config, plan = {}, start = 1700000000000, random = () => 0 } = {}) {
  const clock = createFakeClock(start);
  const counters = createCounters();
  const upstream = createFakeUpstream({ clock });
  for (const [name, list] of Object.entries(plan)) {
    upstream.plan(name, list);
  }
  const guard = createGuard({
    config: mergeConfig(config),
    counters,
    transport: upstream.transport,
    now: clock.now,
    sleep: clock.sleep,
    random,
  });
  return { guard, counters, clock, upstream };
}

export function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

export function release(value) {
  return { status: 200, headers: {}, body: Buffer.from('{}'), ...value };
}
