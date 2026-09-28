// 读配置、校验：已实现，别改。
import fs from 'node:fs';

const DEFAULTS = {
  timeZone: 'UTC',
};

export function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tickwheel = { ...DEFAULTS, ...(raw.tickwheel ?? {}) };

  if (typeof tickwheel.timeZone !== 'string' || tickwheel.timeZone === '') {
    throw new Error('tickwheel.timeZone 必须是非空字符串');
  }

  return { tickwheel };
}
