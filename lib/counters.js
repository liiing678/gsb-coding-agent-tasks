// 计数器：名字固定（README 里有清单），别改名、也别加新的。
const COUNTER_NAMES = [
  'tickwheel_jobs_total',
  'tickwheel_fired_total',
  'tickwheel_overlap_skipped_total',
  'tickwheel_failed_total',
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
