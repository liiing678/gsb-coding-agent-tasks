import fs from 'node:fs';

const DEFAULTS = {
  budgetMs: 2000,
  attemptTimeoutMs: 300,
  minAttemptRatio: 0.5,
  maxAttempts: 3,
  backoff: { baseMs: 50, factor: 2, maxMs: 400, jitterMs: 0 },
  breaker: {
    windowSize: 20,
    minSamples: 10,
    failureRatio: 0.5,
    cooldownMs: 2000,
    openBackoffFactor: 2,
    cooldownMaxMs: 30000,
    probeConcurrency: 1,
    probeSuccesses: 2,
  },
  bulkhead: { maxConcurrency: 16, queueLimit: 64 },
};

function positiveInt(egress, key) {
  const value = egress[key];
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`egress.${key} 必须是正整数`);
  }
}

function ratio(egress, key) {
  const value = egress[key];
  if (typeof value !== 'number' || !(value > 0) || value > 1) {
    throw new Error(`egress.${key} 必须落在 (0, 1] 里`);
  }
}

export function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const given = raw.egress ?? {};
  const egress = {
    ...DEFAULTS,
    ...given,
    backoff: { ...DEFAULTS.backoff, ...(given.backoff ?? {}) },
    breaker: { ...DEFAULTS.breaker, ...(given.breaker ?? {}) },
    bulkhead: { ...DEFAULTS.bulkhead, ...(given.bulkhead ?? {}) },
  };

  positiveInt(egress, 'budgetMs');
  positiveInt(egress, 'attemptTimeoutMs');
  positiveInt(egress, 'maxAttempts');
  ratio(egress, 'minAttemptRatio');

  for (const key of ['baseMs', 'factor', 'maxMs', 'jitterMs']) {
    const value = egress.backoff[key];
    if (typeof value !== 'number' || value < 0) {
      throw new Error(`egress.backoff.${key} 必须是非负数`);
    }
  }
  for (const key of ['windowSize', 'minSamples', 'cooldownMs', 'probeConcurrency', 'probeSuccesses']) {
    positiveInt(egress.breaker, key);
  }
  for (const key of ['openBackoffFactor', 'cooldownMaxMs']) {
    const value = egress.breaker[key];
    if (typeof value !== 'number' || value <= 0) {
      throw new Error(`egress.breaker.${key} 必须是正数`);
    }
  }
  ratio(egress.breaker, 'failureRatio');
  for (const key of ['maxConcurrency', 'queueLimit']) {
    positiveInt(egress.bulkhead, key);
  }
  if (egress.bulkhead.queueLimit < 1) {
    throw new Error('egress.bulkhead.queueLimit 至少要 1');
  }

  return { egress };
}
