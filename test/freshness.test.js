import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpCache } from '../lib/httpcache.js';

const BASE = Date.parse('2026-01-01T00:00:00Z');
const httpDate = (ms) => new Date(ms).toUTCString();

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'HttpCacheError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

function harness(config = {}) {
  let now = BASE;
  const cache = createHttpCache({ clock: () => now, ...config });
  return { cache, tick: (ms) => { now += ms; }, set: (ms) => { now = ms; } };
}

const get = (url, headers = {}) => ({ method: 'GET', url, headers });
const ok = (headers = {}) => ({ status: 200, headers: { date: httpDate(BASE), ...headers } });

test('存下来之后按 max-age 算新鲜，时间一走过期', () => {
  const { cache, tick } = harness();
  assert.deepEqual(cache.store(get('/a'), ok({ 'cache-control': 'max-age=60' })), {
    stored: true, reason: 'stored', key: 'GET /a',
  });
  const fresh = cache.lookup(get('/a'));
  assert.equal(fresh.status, 'fresh');
  assert.equal(fresh.ageMs, 0);
  assert.equal(fresh.freshnessMs, 60_000);
  assert.equal(fresh.requiresRevalidation, false);

  tick(30_000);
  assert.equal(cache.lookup(get('/a')).status, 'fresh');
  assert.equal(cache.lookup(get('/a')).ageMs, 30_000);

  tick(31_000);
  const stale = cache.lookup(get('/a'));
  assert.equal(stale.status, 'stale');
  assert.equal(stale.canServeStale, false);
  assert.equal(stale.requiresRevalidation, true);
});

test('不能存的那些情况各给一个 reason', () => {
  const { cache } = harness();
  assert.deepEqual(cache.store({ method: 'POST', url: '/a', headers: {} }, ok()), {
    stored: false, reason: 'method',
  });
  assert.deepEqual(cache.store(get('/a'), ok({ 'cache-control': 'no-store' })), {
    stored: false, reason: 'no-store',
  });
  assert.deepEqual(cache.store(get('/a', { 'cache-control': 'no-store' }), ok()), {
    stored: false, reason: 'no-store',
  });
  assert.deepEqual(cache.store(get('/a'), ok({ 'cache-control': 'private, max-age=60' })), {
    stored: false, reason: 'private',
  });
  assert.deepEqual(cache.store(get('/a'), { status: 500, headers: { date: httpDate(BASE), 'cache-control': 'max-age=60' } }), {
    stored: false, reason: 'status',
  });
  assert.deepEqual(cache.store(get('/a', { authorization: 'Bearer t' }), ok({ 'cache-control': 'max-age=60' })), {
    stored: false, reason: 'authorization',
  });
  assert.equal(cache.store(get('/a', { authorization: 'Bearer t' }), ok({ 'cache-control': 'public, max-age=60' })).stored, true);
  assert.equal(cache.store(get('/b'), ok({ 'cache-control': 'max-age=60', vary: '*' })).reason, 'vary');
});

test('s-maxage 压过 max-age，Expires 只在没有显式秒数时才算', () => {
  const { cache, tick } = harness();
  cache.store(get('/a'), ok({ 'cache-control': 'max-age=10, s-maxage=100' }));
  tick(50_000);
  assert.equal(cache.lookup(get('/a')).status, 'fresh');

  cache.store(get('/b'), ok({ expires: httpDate(BASE + 40_000) }));
  assert.equal(cache.lookup(get('/b')).freshnessMs, 40_000);
  tick(39_999);
  assert.equal(cache.lookup(get('/b')).status, 'fresh');
  tick(1);
  assert.equal(cache.lookup(get('/b')).status, 'stale');
});

test('Age 头算进年龄：一存下来就可能已经过期', () => {
  const { cache } = harness();
  cache.store(get('/a'), ok({ 'cache-control': 'max-age=60', age: '70' }));
  const found = cache.lookup(get('/a'));
  assert.equal(found.ageMs, 70_000);
  assert.equal(found.status, 'stale');
  assert.equal(found.requiresRevalidation, true);
});

test('没有显式新鲜度时用 Last-Modified 的 10% 兜底，没有就立刻过期', () => {
  const { cache, tick } = harness();
  cache.store(get('/a'), ok({ 'last-modified': httpDate(BASE - 1_000_000) }));
  assert.equal(cache.lookup(get('/a')).freshnessMs, 100_000);
  tick(99_999);
  assert.equal(cache.lookup(get('/a')).status, 'fresh');
  tick(1);
  assert.equal(cache.lookup(get('/a')).status, 'stale');

  cache.store(get('/b'), ok({}));
  assert.equal(cache.lookup(get('/b')).freshnessMs, 0);
  assert.equal(cache.lookup(get('/b')).status, 'stale');
});

test('响应带 no-cache 就一直要回源，带 must-revalidate 的过期不许 stale 复用', () => {
  const { cache, tick } = harness();
  cache.store(get('/a'), ok({ 'cache-control': 'no-cache, max-age=600' }));
  const forced = cache.lookup(get('/a'));
  assert.equal(forced.status, 'must-revalidate');
  assert.equal(forced.canServeStale, false);

  cache.store(get('/b'), ok({ 'cache-control': 'max-age=10, must-revalidate, stale-while-revalidate=600' }));
  tick(11_000);
  const strict = cache.lookup(get('/b'));
  assert.equal(strict.status, 'must-revalidate');
  assert.equal(strict.canServeStale, false);
  assert.equal(strict.requiresRevalidation, true);
});

test('stale-while-revalidate 窗口内可以顶，窗口外不行', () => {
  const { cache, tick } = harness();
  cache.store(get('/a'), ok({ 'cache-control': 'max-age=10, stale-while-revalidate=30' }));
  tick(20_000);
  const inside = cache.lookup(get('/a'));
  assert.equal(inside.status, 'stale');
  assert.equal(inside.canServeStale, true);
  assert.equal(inside.requiresRevalidation, false);
  tick(20_000);
  const outside = cache.lookup(get('/a'));
  assert.equal(outside.canServeStale, false);
  assert.equal(outside.requiresRevalidation, true);
});

test('请求自己说 no-cache 或 no-store 时不许直接用缓存', () => {
  const { cache } = harness();
  cache.store(get('/a'), ok({ 'cache-control': 'max-age=600' }));
  const forced = cache.lookup(get('/a', { 'cache-control': 'no-cache' }));
  assert.equal(forced.status, 'must-revalidate');
  assert.equal(forced.canServeStale, false);
  assert.deepEqual(cache.lookup(get('/a', { 'cache-control': 'no-store' })), {
    hit: false, status: 'miss', entry: null, ageMs: null, freshnessMs: null,
    canServeStale: false, requiresRevalidation: true,
  });
  assert.equal(cache.stats().misses, 1);
});

test('Vary 指定的头对不上就不能复用，缺头按空值比对', () => {
  const { cache } = harness();
  cache.store(get('/a', { 'accept-encoding': 'gzip' }), ok({ 'cache-control': 'max-age=60', vary: 'Accept-Encoding' }));
  assert.equal(cache.lookup(get('/a', { 'accept-encoding': 'gzip' })).hit, true);
  assert.equal(cache.lookup(get('/a', { 'accept-encoding': 'br' })).status, 'miss');
  assert.equal(cache.lookup(get('/a')).status, 'miss');
  cache.store(get('/a'), ok({ 'cache-control': 'max-age=60', vary: 'accept-encoding' }));
  assert.equal(cache.lookup(get('/a')).hit, true);
  assert.equal(cache.stats().entries, 2);
});

test('返回的头是拷贝，外面改它不影响缓存里那份', () => {
  const { cache } = harness();
  cache.store(get('/a'), ok({ 'cache-control': 'max-age=60', etag: '"v1"' }));
  const found = cache.lookup(get('/a'));
  found.entry.headers.etag = '"mutated"';
  assert.equal(cache.lookup(get('/a')).entry.headers.etag, '"v1"');
});

test('参数不合法时各报哪个码', () => {
  const { cache } = harness();
  expectError(() => cache.store(null, ok()), 'ERR_BAD_REQUEST');
  expectError(() => cache.store({ method: 'GET', url: '' }, ok()), 'ERR_BAD_REQUEST');
  expectError(() => cache.store(get('/a', { 'cache-control': 5 }), ok()), 'ERR_BAD_REQUEST');
  expectError(() => cache.store(get('/a'), null), 'ERR_BAD_RESPONSE');
  expectError(() => cache.store(get('/a'), { status: 99, headers: {} }), 'ERR_BAD_RESPONSE');
  expectError(() => createHttpCache(null), 'ERR_BAD_CONFIG');
  expectError(() => createHttpCache({ maxEntries: 0 }), 'ERR_BAD_CONFIG');
  expectError(() => createHttpCache({ heuristicFraction: 1.5 }), 'ERR_BAD_CONFIG');
});
