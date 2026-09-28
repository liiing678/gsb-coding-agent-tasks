// 用例自己的驱动：不开真连接，能数清楚建了几条、关了几条、同时存在几条。
export function createFakeDriver() {
  const live = new Set();
  const broken = new Set();
  const closes = [];
  let created = 0;
  let liveMax = 0;

  return {
    closes,
    broken,
    get created() {
      return created;
    },
    liveCount: () => live.size,
    liveMax: () => liveMax,
    isLive: (conn) => live.has(conn),
    isBroken: (conn) => broken.has(conn),
    breakConn(conn) {
      broken.add(conn);
    },
    async open() {
      created += 1;
      const conn = { id: `c${created}` };
      // 故意等一个 tick 才建成：创建这段时间池子也得把额度算上。
      await new Promise((resolve) => setImmediate(resolve));
      live.add(conn);
      liveMax = Math.max(liveMax, live.size);
      return conn;
    },
    async close(conn) {
      live.delete(conn);
      closes.push(conn);
    },
  };
}
