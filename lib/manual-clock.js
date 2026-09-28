// 手动时钟：已实现，别改。
//
// 演示和用例都靠它推进时间：sleep(ms) 挂在那儿，等 advance(ms) 把时间推过去才放行。
// 调度器要用的 now / sleep 都从这里拿。
export function createManualClock(start = Date.UTC(2026, 0, 1, 0, 0)) {
  let current = start;
  const waiters = [];

  return {
    now: () => current,
    pending: () => waiters.length,
    sleep(ms) {
      const dueAt = current + ms;
      return new Promise((resolve) => {
        waiters.push({ dueAt, resolve });
      });
    },
    async advance(ms) {
      const target = current + ms;
      for (let round = 0; round < 20000; round += 1) {
        let index = -1;
        let earliest = Infinity;
        waiters.forEach((waiter, i) => {
          if (waiter.dueAt <= target && waiter.dueAt < earliest) {
            earliest = waiter.dueAt;
            index = i;
          }
        });
        if (index === -1) {
          break;
        }
        const [waiter] = waiters.splice(index, 1);
        // 时间先走到它到点的那一刻，再放行：这样"现在"就是它该醒的时间，不会凭空迟到。
        current = Math.max(current, waiter.dueAt);
        waiter.resolve();
        await new Promise((resolve) => setImmediate(resolve));
      }
      current = target;
      return current;
    },
  };
}
