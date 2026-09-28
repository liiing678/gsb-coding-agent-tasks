import { createMetrics } from '../../src/metrics.js';
import { createServer } from '../../src/server.js';

// 用例自己用的配置：TTL 和几个上限都调小了，跑得快。
const BASE = {
  listen: { host: '127.0.0.1', port: 0 },
  idempotency: { ttlMs: 1000, maxEntries: 8, maxWaiters: 4, maxKeyBytes: 64 },
};

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startApp({ handler, idempotency = {}, now } = {}) {
  const metrics = createMetrics();
  const config = { ...BASE, idempotency: { ...BASE.idempotency, ...idempotency } };
  const server = createServer({ config, metrics, handler, now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    metrics,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

// 发一个写请求：key 给 undefined 就是不带 Idempotency-Key。
export function post(base, key, body = '', { path = '/write', headers = {} } = {}) {
  const merged = { ...headers };
  if (key !== undefined && key !== null) {
    merged['idempotency-key'] = key;
  }
  return fetch(`${base}${path}`, { method: 'POST', headers: merged, body });
}
