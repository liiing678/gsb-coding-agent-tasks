// 计数器：名字固定（README 里有清单），别改名、也别加新的。
const COUNTER_NAMES = [
  'idem_requests_total',
  'idem_passthrough_total',
  'idem_executed_total',
  'idem_replayed_total',
  'idem_waited_total',
  'idem_conflicts_total',
  'idem_evicted_total',
  'idem_aborted_total',
  'idem_rejected_total',
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
