// 假时钟：时间由用例自己推，不用真的等。
// sleep(ms) 会把时间直接往前拨 ms 并立刻返回，省得用例去等——别指望它真的等。
export function createFakeClock(start = 1700000000000) {
  let current = start;
  const sleeps = [];
  return {
    start,
    sleeps,
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
    sleep(ms) {
      sleeps.push(ms);
      current += ms;
      return Promise.resolve();
    },
  };
}
