// 假时钟：时间由用例自己推，不用真的等。now 的形状跟服务要的一样。
export function createFakeClock(start = 1700000000000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
  };
}
