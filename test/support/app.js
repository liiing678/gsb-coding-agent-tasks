import { createMetrics } from '../../src/metrics.js';
import { normalizeKeys } from '../../src/keys.js';
import { createServer } from '../../src/server.js';
import { createTokenService } from '../../src/tokens.js';
import { createFakeClock } from './fake-clock.js';
import { createSeededRandom } from './random.js';

// 用例自己的配置：TTL 和容差都调小了，跑得快。
export const START = 1700000000000;
export const ACCESS_TTL = 1000;
export const REFRESH_TTL = 60000;
export const SKEW = 5;

export const DEV_KEYS = [
  { kid: 'k2', secret: 'test-secret-k2', state: 'active', verifyUntil: null },
  {
    kid: 'k1',
    secret: 'test-secret-k1',
    state: 'verifyOnly',
    verifyUntil: '2023-11-15T00:00:00.000Z',
  },
];

export const BASE_TOKENS = {
  issuer: 'tokenkeeper-test',
  accessTtlMs: ACCESS_TTL,
  refreshTtlMs: REFRESH_TTL,
  clockSkewMs: SKEW,
  revocationCapacity: 4,
};

export function makeService({
  tokens = {},
  keys = DEV_KEYS,
  clock = createFakeClock(START),
  random = createSeededRandom(7),
} = {}) {
  const metrics = createMetrics();
  const config = { ...BASE_TOKENS, ...tokens };
  const service = createTokenService({
    config,
    metrics,
    keys: normalizeKeys(keys),
    now: clock.now,
    random,
  });
  return { service, metrics, clock, config };
}

export async function startApp(options = {}) {
  const { service, metrics, clock, config } = makeService(options);
  const server = createServer({
    config: {
      listen: { host: '127.0.0.1', port: 0 },
      tokens: config,
      keys: normalizeKeys(options.keys ?? DEV_KEYS),
    },
    metrics,
    service,
    now: clock.now,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    metrics,
    clock,
    service,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

export function postJson(base, path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
