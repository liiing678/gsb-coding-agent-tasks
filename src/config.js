import fs from 'node:fs';

const DEFAULTS = {
  listen: { host: '127.0.0.1', port: 8080 },
  idempotency: { ttlMs: 60000, maxEntries: 1024, maxWaiters: 32, maxKeyBytes: 128 },
};

export function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const config = {
    listen: { ...DEFAULTS.listen, ...(raw.listen ?? {}) },
    idempotency: { ...DEFAULTS.idempotency, ...(raw.idempotency ?? {}) },
  };

  const { port } = config.listen;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('listen.port 必须是 0..65535 的整数');
  }
  for (const key of ['ttlMs', 'maxEntries', 'maxWaiters', 'maxKeyBytes']) {
    const value = config.idempotency[key];
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`idempotency.${key} 必须是正整数`);
    }
  }
  return config;
}
