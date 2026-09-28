// 假时钟：时间由用例自己推，不会真的等。
//
// sleep(ms) 不会自己到点——它挂在那儿，等用例调 advance(ms) 把时间推过去才放行。
// 这样 drain 超时这类"要等一会儿"的行为都能卡着验。
export function createFakeClock(start = 1700000000000) {
  let current = start;
  const waiters = [];

  return {
    start,
    now: () => current,
    pending: () => waiters.length,
    sleep(ms) {
      const dueAt = current + ms;
      return new Promise((resolve) => {
        waiters.push({ dueAt, resolve });
      });
    },
    async advance(ms) {
      current += ms;
      for (let round = 0; round < 1000; round += 1) {
        let index = -1;
        let earliest = Infinity;
        waiters.forEach((waiter, i) => {
          if (waiter.dueAt <= current && waiter.dueAt < earliest) {
            earliest = waiter.dueAt;
            index = i;
          }
        });
        if (index === -1) break;
        const [waiter] = waiters.splice(index, 1);
        waiter.resolve();
        await new Promise((resolve) => setImmediate(resolve));
      }
      return current;
    },
  };
}
