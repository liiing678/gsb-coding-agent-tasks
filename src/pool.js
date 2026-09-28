// 这个文件就是要写的那块：现在是空的，只会抛 NotImplementedError。
//
// createPool({ config, driver, counters, now, sleep }) -> { acquire(), stats(), close() }
//   config   : configs/dev.json 里 connlease 那一段（config.js 已经校验过），字段见 README
//   driver   : 下游连接的驱动，形状见 README 的《接口》
//   counters : src/counters.js 的计数器，名字见 README
//   now      : 取当前时间，默认 () => Date.now()
//   sleep    : 等 ms 毫秒，默认 setTimeout；测试会换成假时钟
//
// acquire / stats / close，以及 acquire 拿到的 lease 上的 release 怎么用，
// 语义都在 README 的《口径》里。
import {
  AcquireTimeoutError,
  PoolClosedError,
  PoolExhaustedError,
} from './errors.js';

export function createPool({
  config,
  driver,
  counters,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    if (typeof handle.unref === 'function') {
      handle.unref();
    }
  }),
} = {}) {
  if (!config) {
    throw new Error('createPool 需要 config');
  }
  if (!driver) {
    throw new Error('createPool 需要 driver');
  }
  if (!counters) {
    throw new Error('createPool 需要 counters');
  }

  // idle：已建好、躺在池子里等借出的连接（FIFO）。
  const idle = [];
  // conn -> 当前持有的租约对象；租约对象身份用来认人，旧租约不能动新借主。
  const borrowed = new Map();
  // 排队等连接的人，FIFO。元素是 { resolve, reject, settled }。
  const waiters = [];
  // open() 还在飞行中的那批 owner（直接 acquire 的、或从队首派去建新连接的）。
  const creatingOwners = new Set();
  // 已经发起、还没落定的 driver.close()。
  const closingConns = new Set();
  let creating = 0;
  let nextLeaseId = 1;
  let closed = false;
  let closePromise = null;
  let closeResolve = null;

  const liveCount = () => idle.length + borrowed.size;

  function maybeResolveClose() {
    if (!closed || !closeResolve) {
      return;
    }
    if (
      idle.length === 0 &&
      borrowed.size === 0 &&
      creating === 0 &&
      closingConns.size === 0
    ) {
      const resolve = closeResolve;
      closeResolve = null;
      resolve();
    }
  }

  // 关连接不能卡住池子：close 报错吞掉，调用方通过 pending 集合等它落定。
  function closeConn(conn) {
    const done = Promise.resolve()
      .then(() => driver.close(conn))
      .catch(() => {});
    closingConns.add(done);
    done.then(() => {
      closingConns.delete(done);
      maybeResolveClose();
    });
    return done;
  }

  // 判定为坏连接并销毁（调用方已保证它不在 idle / borrowed 里）。
  function destroyBroken(conn) {
    counters.inc('connlease_broken_total');
    return closeConn(conn);
  }

  function makeLeaseApi(lease) {
    return {
      id: lease.id,
      conn: lease.conn,
      release: (options) => releaseLease(lease, options),
    };
  }

  function handOut(owner, conn) {
    const lease = { id: nextLeaseId, conn, borrowedAt: now() };
    nextLeaseId += 1;
    borrowed.set(conn, lease);
    counters.inc('connlease_borrowed_total');
    owner.settled = true;
    owner.resolve(makeLeaseApi(lease));
  }

  // 从空闲堆里取一条好连接；坏掉的当场销毁换一条，绝不借出去。
  function takeHealthyIdle() {
    while (idle.length > 0) {
      const conn = idle.shift();
      if (driver.isBroken(conn)) {
        destroyBroken(conn);
        continue;
      }
      return conn;
    }
    return null;
  }

  // 额度在调 open() 之前就占掉：creating++ 是同步的，
  // 所以一堆 acquire 同时进来也不会把 maxConnections 顶破。
  function startCreate(owner) {
    creating += 1;
    creatingOwners.add(owner);
    driver.open().then(
      (conn) => {
        creating -= 1;
        creatingOwners.delete(owner);
        counters.inc('connlease_created_total');
        // 关池期间 owner 已被拒，或者 owner 已经落定：新连接是孤儿，直接关。
        if (closed || owner.settled) {
          closeConn(conn);
          maybeResolveClose();
          return;
        }
        handOut(owner, conn);
      },
      (err) => {
        creating -= 1;
        creatingOwners.delete(owner);
        if (!owner.settled) {
          owner.settled = true;
          owner.reject(err);
        }
        // 额度还回去了，排队的人可以顶上。
        if (!closed) {
          dispatch();
        }
        maybeResolveClose();
      },
    );
  }

  // 有空连接/有额度就把排队的人安排上，FIFO，不许插队。
  function dispatch() {
    if (closed) {
      return;
    }
    while (waiters.length > 0) {
      const conn = takeHealthyIdle();
      if (conn) {
        handOut(waiters.shift(), conn);
        continue;
      }
      if (liveCount() + creating < config.maxConnections) {
        startCreate(waiters.shift());
      } else {
        break;
      }
    }
  }

  function serveOrQueue(owner) {
    const conn = takeHealthyIdle();
    if (conn) {
      handOut(owner, conn);
      return;
    }
    if (liveCount() + creating < config.maxConnections) {
      startCreate(owner);
      return;
    }
    if (waiters.length >= config.maxWaiters) {
      counters.inc('connlease_rejected_total');
      owner.settled = true;
      owner.reject(new PoolExhaustedError());
      return;
    }
    waiters.push(owner);
    counters.inc('connlease_waited_total');
    sleep(config.acquireTimeoutMs).then(() => {
      if (owner.settled) {
        return;
      }
      const index = waiters.indexOf(owner);
      if (index !== -1) {
        waiters.splice(index, 1);
      }
      owner.settled = true;
      counters.inc('connlease_wait_timeout_total');
      owner.reject(new AcquireTimeoutError());
    });
  }

  function releaseLease(lease, options = {}) {
    // 只认真正的当前租约：重复 release、旧租约到点后才还，统统幂等 no-op。
    if (borrowed.get(lease.conn) !== lease) {
      return;
    }
    const { conn } = lease;
    borrowed.delete(conn);
    counters.inc('connlease_returned_total');

    const broken = options?.broken === true || driver.isBroken(conn);
    if (broken) {
      destroyBroken(conn);
      if (!closed) {
        dispatch();
      }
    } else if (closed) {
      // 关池中还回来的：不留宿，直接关。
      closeConn(conn);
    } else {
      idle.push(conn);
      dispatch();
    }
    maybeResolveClose();
  }

  // 租约回收：只认当前租约，销毁坏连接、放额度给排队的人。
  function reclaim(conn, lease) {
    if (borrowed.get(conn) !== lease) {
      return;
    }
    borrowed.delete(conn);
    counters.inc('connlease_broken_total');
    counters.inc('connlease_lease_expired_total');
    closeConn(conn);
    if (closed) {
      maybeResolveClose();
    } else {
      dispatch();
    }
  }

  function scanLeases() {
    const deadline = now() - config.leaseTimeoutMs;
    const expired = [];
    for (const [conn, lease] of borrowed) {
      if (lease.borrowedAt <= deadline) {
        expired.push([conn, lease]);
      }
    }
    for (const [conn, lease] of expired) {
      reclaim(conn, lease);
    }
  }

  // 回收扫描走注入的 now/sleep；关池后也继续扫，
  // 让"借出去没还、租约到点"的连接能在关池期间被收掉。
  (async () => {
    while (!closed || borrowed.size > 0) {
      await sleep(config.reclaimIntervalMs);
      scanLeases();
    }
  })();

  return {
    acquire() {
      counters.inc('connlease_acquire_total');
      if (closed) {
        return Promise.reject(new PoolClosedError());
      }
      return new Promise((resolve, reject) => {
        serveOrQueue({ resolve, reject, settled: false });
      });
    },
    stats() {
      return {
        live: liveCount(),
        idle: idle.length,
        borrowed: borrowed.size,
        creating,
        waiters: waiters.length,
        counters: counters.snapshot(),
      };
    },
    close() {
      if (closePromise) {
        return closePromise;
      }
      closed = true;
      closePromise = new Promise((resolve) => {
        closeResolve = resolve;
      });

      // 排队的、以及正在等 open 的，全部叫醒拒掉。
      const owners = waiters.splice(0, waiters.length).concat([...creatingOwners]);
      for (const owner of owners) {
        if (!owner.settled) {
          owner.settled = true;
          owner.reject(new PoolClosedError());
        }
      }

      // 空闲连接立刻关；借出去的等还回来（或租约到点）再关。
      const pendingIdle = idle.splice(0, idle.length);
      for (const conn of pendingIdle) {
        closeConn(conn);
      }

      maybeResolveClose();
      return closePromise;
    },
  };
}
