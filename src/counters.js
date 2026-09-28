// 计数器：名字固定（README 里有清单），别改名、也别加新的。
const COUNTER_NAMES = [
  'connlease_acquire_total',
  'connlease_borrowed_total',
  'connlease_created_total',
  'connlease_waited_total',
  'connlease_wait_timeout_total',
  'connlease_rejected_total',
  'connlease_returned_total',
  'connlease_broken_total',
  'connlease_lease_expired_total',
];

export function createCounters() {
  const values = new Map(COUNTER_NAMES.map((name) => [name, 0]));
  return {
    names: COUNTER_NAMES,
    inc(name, by = 1) {
      if (!values.has(name)) {
        throw new Error(`没有这个计数器: ${name}`);
      }
      values.set(name, values.get(name) + by);
    },
    snapshot() {
      return Object.fromEntries(values);
    },
  };
}
