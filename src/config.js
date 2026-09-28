import fs from 'node:fs';

const DEFAULTS = {
  defaultTtlMs: 60000,
  negativeTtlMs: 5000,
  lockTtlMs: 3000,
  lockRetryMs: 100,
  lockWaitMs: 5000,
  failMode: 'fail_open',
};

const FAIL_MODES = ['fail_open', 'fail_fast'];

function positiveInt(cache, key) {
  const value = cache[key];
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`cache.${key} 必须是正整数`);
  }
}

export function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cache = { ...DEFAULTS, ...(raw.cache ?? {}) };

  for (const key of ['defaultTtlMs', 'negativeTtlMs', 'lockTtlMs', 'lockRetryMs', 'lockWaitMs']) {
    positiveInt(cache, key);
  }
  if (!FAIL_MODES.includes(cache.failMode)) {
    throw new Error(`cache.failMode 只能是 ${FAIL_MODES.join(' 或 ')}`);
  }

  return { cache };
}
