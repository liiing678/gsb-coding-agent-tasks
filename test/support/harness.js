import { createCache } from '../../src/cache.js';
import { createCounters } from '../../src/counters.js';
import { createSharedStore } from '../../src/shared-store.js';
import { createFakeClock } from './fake-clock.js';
import { createFakeLoader } from './fake-loader.js';

// 用例自己的配置：TTL 和上限都调小了，跑得快。
export const BASE_CONFIG = {
  defaultTtlMs: 60000,
  negativeTtlMs: 5000,
  lockTtlMs: 1000,
  lockRetryMs: 100,
  lockWaitMs: 2000,
  failMode: 'fail_open',
};

export function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

// 一个实例
export function setUp({ config = {}, start = 1700000000000 } = {}) {
  const world = createWorld(start);
  const counters = createCounters();
  const cache = createCache({
    config: { ...BASE_CONFIG, ...config },
    counters,
    store: world.store,
    loader: world.loader.load,
    now: world.clock.now,
    sleep: world.clock.sleep,
  });
  return { cache, counters, ...world };
}

// 两个实例共用一份共享存储 = 线上两个 pod 对着同一个 Redis
export function setUpPair({ config = {} } = {}) {
  const world = createWorld(1700000000000);
  const countersA = createCounters();
  const countersB = createCounters();
  const fullConfig = { ...BASE_CONFIG, ...config };
  const make = (counters) => createCache({
    config: fullConfig,
    counters,
    store: world.store,
    loader: world.loader.load,
    now: world.clock.now,
    sleep: world.clock.sleep,
  });
  return { a: make(countersA), b: make(countersB), countersA, countersB, ...world };
}

function createWorld(start) {
  const clock = createFakeClock(start);
  const store = createSharedStore({ now: clock.now });
  const loader = createFakeLoader();
  return { clock, store, loader };
}
