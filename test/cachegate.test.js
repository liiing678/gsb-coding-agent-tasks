import assert from 'node:assert/strict';
import test from 'node:test';

import { setUp, setUpPair, tick } from './support/harness.js';

const TAGS = ['category:9'];

test('第一次回源、第二次命中：回源只跑一次', async () => {
  const { cache, counters, loader } = setUp();
  loader.plan([{ value: 'v1' }]);

  assert.equal(await cache.get('product:9', { tags: TAGS }), 'v1');
  assert.equal(await cache.get('product:9', { tags: TAGS }), 'v1');

  assert.equal(loader.calls.length, 1);
  const snapshot = counters.snapshot();
  assert.equal(snapshot.cache_gets_total, 2);
  assert.equal(snapshot.cache_misses_total, 1);
  assert.equal(snapshot.cache_hits_total, 1);
  assert.equal(snapshot.cache_loads_total, 1);
});

test('同一个实例里并发 get 同一个 key，只回源一次', async () => {
  const { cache, loader } = setUp();
  loader.plan([{ hold: true }]);

  const pending = [
    cache.get('k', { tags: [] }),
    cache.get('k', { tags: [] }),
    cache.get('k', { tags: [] }),
  ];
  await tick();
  assert.equal(loader.calls.length, 1);
  assert.equal(cache.stats().inflight, 1);

  loader.release(0, { value: 'v' });
  assert.deepEqual(await Promise.all(pending), ['v', 'v', 'v']);
  assert.equal(loader.calls.length, 1);
  assert.equal(cache.stats().inflight, 0);
});

test('跨实例并发：另一个实例等锁，不跟着打 origin', async () => {
  const { a, b, clock, loader } = setUpPair();
  loader.plan([{ hold: true }]);

  const pa = a.get('k', { tags: [] });
  await tick();
  const pb = b.get('k', { tags: [] });
  await tick();
  assert.equal(loader.calls.length, 1);

  loader.release(0, { value: 'v' });
  await tick();
  await clock.advance(100); // b 的 lockRetryMs 到点，回去重读缓存
  await tick();

  assert.equal(await pb, 'v');
  assert.equal(await pa, 'v');
  assert.equal(loader.calls.length, 1);
});

test('回源失败：等待者拿到同一个错误，而且什么都没写', async () => {
  const { cache, counters, loader, store } = setUp();
  loader.plan([{ hold: true }]);

  const p1 = cache.get('k', { tags: [] });
  const p2 = cache.get('k', { tags: [] });
  await tick();

  const boom = new Error('origin 回了 500');
  loader.fail(0, boom);
  await assert.rejects(p1, (error) => error === boom);
  await assert.rejects(p2, (error) => error === boom);

  assert.equal(await store.get('cache:k'), null);
  assert.equal(counters.snapshot().cache_load_errors_total, 1);

  loader.plan([{ value: 'v2' }]);
  assert.equal(await cache.get('k', { tags: [] }), 'v2');
  assert.equal(loader.calls.length, 2);
});

test('负缓存：found:false 之后 TTL 内不再戳 origin', async () => {
  const { cache, clock, loader } = setUp();
  loader.plan([{ notFound: true }]);

  assert.equal(await cache.get('k', { tags: [] }), null);
  assert.equal(await cache.get('k', { tags: [] }), null);
  assert.equal(loader.calls.length, 1);

  await clock.advance(5000); // negativeTtlMs
  await tick();
  loader.plan([{ value: 'v' }]);
  assert.equal(await cache.get('k', { tags: [] }), 'v');
  assert.equal(loader.calls.length, 2);
});

test('条目 TTL 到点就重新回源', async () => {
  const { cache, clock, loader } = setUp();
  loader.plan([{ value: 'v1', ttlMs: 1000 }, { value: 'v2' }]);

  assert.equal(await cache.get('k', { tags: [] }), 'v1');
  await clock.advance(1000);
  await tick();
  assert.equal(await cache.get('k', { tags: [] }), 'v2');
  assert.equal(loader.calls.length, 2);
});

test('回源途中被失效：结果不许写回去', async () => {
  const { cache, counters, loader, store } = setUp();
  loader.plan([{ hold: true }]);

  const pending = cache.get('product:9', { tags: TAGS });
  await tick();
  await cache.invalidateTag('category:9');
  loader.release(0, { value: 'v1' });

  assert.equal(await pending, 'v1'); // 这次调用照样把它读到的值给调用方
  assert.equal(await store.get('cache:product:9'), null); // 但不许写回缓存
  assert.equal(counters.snapshot().cache_fenced_writes_total, 1);

  loader.plan([{ value: 'v2' }]);
  assert.equal(await cache.get('product:9', { tags: TAGS }), 'v2');
  assert.equal(loader.calls.length, 2);
});

test('读的时候校验 tag 世代：别的实例失效过就不许命中旧条目', async () => {
  const { a, b, countersA, loader } = setUpPair();

  loader.plan([{ value: 'v1' }]);
  assert.equal(await a.get('product:9', { tags: TAGS }), 'v1');

  await b.invalidateTag('category:9'); // 失效是别的实例做的

  loader.plan([{ value: 'v2' }]);
  assert.equal(await a.get('product:9', { tags: TAGS }), 'v2');
  assert.equal(loader.calls.length, 2);
  assert.equal(countersA.snapshot().cache_hits_total, 0);
});

test('锁 TTL 到点能被别的实例接手，不会把 key 锁死', async () => {
  const { a, b, clock, loader, store } = setUpPair();
  loader.plan([{ hold: true }]);

  const pa = a.get('k', { tags: [] });
  await tick();
  const pb = b.get('k', { tags: [] });
  await tick();
  assert.equal(loader.calls.length, 1); // a 卡在回源上，b 在等

  await clock.advance(1000); // lockTtlMs 到点
  await tick();
  assert.deepEqual(await pb, { key: 'k' }); // b 接手并回源成功
  assert.equal(loader.calls.length, 2);
  assert.notEqual(await store.get('cache:k'), null);
  void pa; // a 那次还挂着，不管它
});

test('自己的锁过期之后，回来不能把别人的锁删掉', async () => {
  const { a, b, clock, loader, store } = setUpPair();
  loader.plan([{ hold: true }, { hold: true }]);

  const pa = a.get('k', { tags: [] });
  await tick();
  const pb = b.get('k', { tags: [] });
  await tick();

  await clock.advance(1000); // a 的锁过期，b 抢到并开始回源
  await tick();
  assert.equal(loader.held.length, 2);

  loader.release(0, { value: 'old' }); // a 现在才回来
  assert.equal(await pa, 'old');
  assert.notEqual(await store.get('cache:lock:k'), null); // b 的锁还在

  loader.release(1, { value: 'new' });
  assert.equal(await pb, 'new');
});

test('共享存储抖掉：fail_open 直接回源，不写缓存', async () => {
  const { cache, counters, loader, store } = setUp();
  store.setDown(true);
  loader.plan([{ value: 'v' }]);

  assert.equal(await cache.get('k', { tags: TAGS }), 'v');
  assert.equal(counters.snapshot().cache_degraded_total, 1);

  store.setDown(false);
  assert.deepEqual(store.dump(), {});
});

test('共享存储抖掉：fail_fast 直接抛 CacheUnavailableError', async () => {
  const { cache, loader, store } = setUp({ config: { failMode: 'fail_fast' } });
  store.setDown(true);

  await assert.rejects(
    cache.get('k', { tags: [] }),
    (error) => error.code === 'cache_unavailable',
  );
  assert.equal(loader.calls.length, 0);
});

test('两个实例同时失效同一个 tag：世代号只增不减', async () => {
  const { a, b, loader, store } = setUpPair();
  loader.plan([{ value: 'v1' }, { value: 'v1' }, { value: 'v1' }]);

  await a.get('k1', { tags: TAGS });
  await a.get('k2', { tags: TAGS });
  await b.get('k3', { tags: TAGS });

  await Promise.all([a.invalidateTag('category:9'), b.invalidateTag('category:9')]);
  assert.equal(Number(await store.get('cache:gen:category:9')), 2);

  loader.plan([{ value: 'v2' }, { value: 'v2' }]);
  assert.equal(await b.get('k1', { tags: TAGS }), 'v2');
  assert.equal(await a.get('k2', { tags: TAGS }), 'v2');
  assert.equal(loader.calls.length, 5);
});
