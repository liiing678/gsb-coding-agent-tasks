// 时钟。引擎只通过它取时间，测试里换成手动时钟就能把时间捏在手里。
export function createManualClock(startMs = 0) {
  let current = startMs;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
    set(ms) {
      current = ms;
      return current;
    },
  };
}

export function createSystemClock() {
  return { now: () => Date.now() };
}
