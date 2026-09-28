import fs from 'node:fs';

import { normalizeKeys } from './keys.js';

const DEFAULTS = {
  listen: { host: '127.0.0.1', port: 8080 },
  tokens: {
    issuer: 'tokenkeeper-dev',
    accessTtlMs: 900000,
    refreshTtlMs: 1209600000,
    clockSkewMs: 30000,
    revocationCapacity: 4096,
  },
  keys: [],
};

export function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const config = {
    listen: { ...DEFAULTS.listen, ...(raw.listen ?? {}) },
    tokens: { ...DEFAULTS.tokens, ...(raw.tokens ?? {}) },
    keys: normalizeKeys(raw.keys ?? DEFAULTS.keys),
  };

  const { port } = config.listen;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('listen.port 必须是 0..65535 的整数');
  }
  if (typeof config.tokens.issuer !== 'string' || config.tokens.issuer === '') {
    throw new Error('tokens.issuer 必须是非空字符串');
  }
  for (const key of ['accessTtlMs', 'refreshTtlMs', 'revocationCapacity']) {
    const value = config.tokens[key];
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`tokens.${key} 必须是正整数`);
    }
  }
  if (!Number.isInteger(config.tokens.clockSkewMs) || config.tokens.clockSkewMs < 0) {
    throw new Error('tokens.clockSkewMs 必须是非负整数');
  }
  if (config.tokens.refreshTtlMs <= config.tokens.accessTtlMs) {
    throw new Error('tokens.refreshTtlMs 要大于 tokens.accessTtlMs');
  }
  return config;
}
