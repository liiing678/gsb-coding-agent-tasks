import { createHttpCache } from '../lib/httpcache.js';

const BASE = Date.parse('2026-01-01T00:00:00Z');
const httpDate = (ms) => new Date(ms).toUTCString();
let now = BASE;
const cache = createHttpCache({ clock: () => now });
const get = (url, headers = {}) => ({ method: 'GET', url, headers });
const ok = (headers = {}) => ({ status: 200, headers: { date: httpDate(BASE), ...headers } });
const show = (label, value) => console.log(`    ${label} ${value}`);

console.log('httpcache demo');

console.log('[1] 存一份能放 60 秒的响应');
show('store', JSON.stringify(cache.store(get('/api/list'), ok({ 'cache-control': 'max-age=60' }))));

console.log('[2] 30 秒后还是新的');
now = BASE + 30_000;
show('lookup', JSON.stringify(pick(cache.lookup(get('/api/list')))));

console.log('[3] 70 秒后过期，得回源');
now = BASE + 70_000;
show('lookup', JSON.stringify(pick(cache.lookup(get('/api/list')))));

console.log('[4] 带 stale-while-revalidate 的还能先顶着用');
cache.store(get('/api/feed'), ok({ 'cache-control': 'max-age=10, stale-while-revalidate=60' }));
now = BASE + 100_000;
show('lookup', JSON.stringify(pick(cache.lookup(get('/api/feed')))));

console.log('[5] Vary 对不上就不能复用');
cache.store(get('/api/vary', { 'accept-encoding': 'gzip' }), ok({ 'cache-control': 'max-age=600', vary: 'accept-encoding' }));
show('lookup', JSON.stringify(pick(cache.lookup(get('/api/vary', { 'accept-encoding': 'br' })))));

console.log('[6] 回源 304 只把时间刷一遍');
now = BASE + 130_000;
show('revalidate', JSON.stringify(cache.revalidate(get('/api/list'), {
  status: 304,
  headers: { date: httpDate(now), 'cache-control': 'max-age=60' },
})));
show('lookup', JSON.stringify(pick(cache.lookup(get('/api/list')))));

console.log('[7] 统计');
console.log(`    ${JSON.stringify(cache.stats())}`);

function pick(result) {
  return {
    hit: result.hit,
    status: result.status,
    ageMs: result.ageMs,
    freshnessMs: result.freshnessMs,
    canServeStale: result.canServeStale,
    requiresRevalidation: result.requiresRevalidation,
  };
}
