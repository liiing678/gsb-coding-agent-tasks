// 读配置、校验：已实现，别改。
import fs from 'node:fs';

const DEFAULTS = {
  maxConnections: 4,
  acquireTimeoutMs: 1000,
  leaseTimeoutMs: 5000,
  maxWaiters: 16,
  reclaimIntervalMs: 100,
};

export function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const connlease = { ...DEFAULTS, ...(raw.connlease ?? {}) };

  for (const key of Object.keys(DEFAULTS)) {
    const value = connlease[key];
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`connlease.${key} 必须是正整数`);
    }
  }

  return { connlease };
}
