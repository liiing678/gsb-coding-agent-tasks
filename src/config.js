import fs from 'node:fs';

const DEFAULTS = {
  perConnBuffer: 8,
  defaultOverflowPolicy: 'drop_oldest',
  replayWindow: 32,
  maxSubscriptions: 16,
  drainTimeoutMs: 2000,
};

const POLICIES = ['drop_oldest', 'disconnect'];

function positiveInt(eventpush, key) {
  const value = eventpush[key];
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`eventpush.${key} 必须是正整数`);
  }
}

export function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const eventpush = { ...DEFAULTS, ...(raw.eventpush ?? {}) };

  for (const key of ['perConnBuffer', 'replayWindow', 'maxSubscriptions', 'drainTimeoutMs']) {
    positiveInt(eventpush, key);
  }
  if (!POLICIES.includes(eventpush.defaultOverflowPolicy)) {
    throw new Error(`eventpush.defaultOverflowPolicy 只能是 ${POLICIES.join(' 或 ')}`);
  }

  return { eventpush };
}
