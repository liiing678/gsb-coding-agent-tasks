// 计数器：名字固定（README 里有清单），别改名、也别加新的。
const COUNTER_NAMES = [
  'access_issued_total',
  'refresh_issued_total',
  'refresh_ok_total',
  'refresh_replayed_total',
  'verify_ok_total',
  'verify_rejected_total',
  'token_revoked_total',
  'session_revoked_total',
  'revoke_skipped_total',
  'revocation_rejected_total',
];

export function createMetrics() {
  const counters = new Map(COUNTER_NAMES.map((name) => [name, 0]));
  return {
    names: COUNTER_NAMES,
    inc(name, by = 1) {
      if (!counters.has(name)) {
        throw new Error(`没有这个计数器: ${name}`);
      }
      counters.set(name, counters.get(name) + by);
    },
    snapshot() {
      return Object.fromEntries(counters);
    },
  };
}
