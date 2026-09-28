import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpCache } from '../lib/httpcache.js';

const BASE = Date.parse('2026-01-01T00:00:00Z');
const httpDate = (ms) => new Date(ms).toUTCString();

function harness(config = {}) {
  let now = BASE;
  const cache = createHttpCache({ clock: () => now, ...config });
  return { cache, tick: (ms) => { now += ms; }, set: (ms) => { now = ms; } };
}

const get = (url, headers = {}) => ({ method: 'GET', url, headers });
const ok = (headers = {}) => ({ status: 200, headers: { date: httpDate(BASE), ...headers } });

test('304 只把时间和头刷一遍，正文还是原来那份', () => {
  const { cache, tick } = harness();
  cache.store(get('/a'), ok({ 'cache-control': 'max-age=60', etag: '"v1"' }));
  tick(61_000);
  const report = cache.revalidate(get('/a'), {
    status: 304,
    headers: { date: httpDate(BASE + 61_000), 'cache-control': 'max-age=60' },
  });
  assert.equal(report.action, 'refreshed');
  const found = cache.lookup(get('/a'));
  assert.equal(found.status, 'fresh');
  assert.equal(found.ageMs, 0);
  assert.equal(found.entry.headers.etag, '"v1"');
  assert.equal(cache.stats().revalidations, 1);
});

test('回源拿回整份响应时把旧的换掉', () => {
  const { cache, tick } = harness();
  cache.store(get('/a'), ok({ 'cache-control': 'max-age=60', etag: '"v1"' }));
  tick(61_000);
  const report = cache.revalidate(get('/a'), ok({ 'cache-control': 'max-age=600', etag: '"v2"' }));
  assert.equal(report.action, 'replaced');
  const found = cache.lookup(get('/a'));
  assert.equal(found.status, 'fresh');
  assert.equal(found.freshnessMs, 600_000);
  assert.equal(found.entry.headers.etag, '"v2"');
  assert.equal(cache.stats().entries, 1);
});

test('回源拿回一份不许缓存的东西，旧条目要撤掉', () => {
  const { cache, tick } = harness();
  cache.store(get('/a'), ok({ 'cache-control': 'max-age=60' }));
  tick(61_000);
  const report = cache.revalidate(get('/a'), ok({ 'cache-control': 'no-store' }));
  assert.deepEqual(report, { action: 'evicted', reason: 'no-store' });
  assert.equal(cache.lookup(get('/a')).status, 'miss');
  assert.equal(cache.stats().entries, 0);
});

test('没有旧条目时收到 304 就当没看见', () => {
  const { cache } = harness();
  assert.deepEqual(cache.revalidate(get('/a'), { status: 304, headers: {} }), {
    action: 'ignored', reason: 'no-entry',
  });
  assert.equal(cache.stats().revalidations, 0);
});

test('purge 按 URL 把这条 URL 的所有变体都清掉', () => {
  const { cache } = harness();
  cache.store(get('/a', { 'accept-encoding': 'gzip' }), ok({ 'cache-control': 'max-age=60', vary: 'accept-encoding' }));
  cache.store(get('/a'), ok({ 'cache-control': 'max-age=60', vary: 'accept-encoding' }));
  cache.store(get('/b'), ok({ 'cache-control': 'max-age=60' }));
  assert.deepEqual(cache.purge({ url: '/a' }), { url: '/a', removed: 2 });
  assert.equal(cache.stats().entries, 1);
  assert.deepEqual(cache.purge({ url: '/a' }), { url: '/a', removed: 0 });
});

test('超过 maxEntries 时踢掉最久没用过的', () => {
  const { cache, tick } = harness({ maxEntries: 2 });
  cache.store(get('/a'), ok({ 'cache-control': 'max-age=600' }));
  tick(1_000);
  cache.store(get('/b'), ok({ 'cache-control': 'max-age=600' }));
  tick(1_000);
  cache.lookup(get('/a'));
  tick(1_000);
  cache.store(get('/c'), ok({ 'cache-control': 'max-age=600' }));
  assert.equal(cache.lookup(get('/b')).status, 'miss');
  assert.equal(cache.lookup(get('/a')).status, 'fresh');
  assert.equal(cache.lookup(get('/c')).status, 'fresh');
  assert.equal(cache.stats().evictions, 1);
});

test('统计口径', () => {
  const { cache, tick } = harness();
  cache.store(get('/a'), ok({ 'cache-control': 'max-age=10, stale-while-revalidate=30' }));
  cache.lookup(get('/a'));
  tick(20_000);
  cache.lookup(get('/a'));
  cache.lookup(get('/nope'));
  assert.deepEqual(cache.stats(), {
    entries: 1,
    stores: 1,
    hits: 2,
    misses: 1,
    revalidations: 0,
    evictions: 0,
    staleServed: 1,
  });
});
