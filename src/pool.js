// 连接池实现：借出、归还、排队、租约回收、坏连接销毁、关池。
// 口径见 README 的《接口》《口径》两节。
import { AcquireTimeoutError, PoolClosedError, PoolExhaustedError } from './errors.js';

export function createPool({
  config,
  driver,
  counters,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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

  // idle：已建好、躺在池里等人借的连接（FIFO 复用）。
  const idle = [];
  // borrowed：借出去的连接 -> 当前持有的租约。回收、归还都认这张租约。
  const borrowed = new Map();
  // waiters：排队等连接的调用方，FIFO，不许插队。
  const waiters = [];
  let creating = 0;
  let pendingCloses = 0;
  let nextLeaseId = 1;
  let closed = false;
  let closeResolve = null;
  const closePromise = new Promise((resolve) => {
    closeResolve = resolve;
  });
  let closeStarted = false;

  function liveCount() {
    return idle.length + borrowed.size;
  }

  function outstandingCount() {
    return liveCount() + creating + pendingCloses;
  }

  // 调驱动关连接：关不掉也不能卡住池子，也不重复计数。
  function closeConn(conn, countBroken) {
    if (countBroken) {
      counters.inc('connlease_broken_total');
    }
    pendingCloses += 1;
    Promise.resolve()
      .then(() => driver.close(conn))
      .catch(() => {})
      .finally(() => {
        pendingCloses -= 1;
        checkCloseComplete();
      });
  }

  function grant(waiter, conn) {
    const lease = {
      id: nextLeaseId,
      conn,
      released: false,
      deadline: now() + config.leaseTimeoutMs,
    };
    nextLeaseId += 1;
    borrowed.set(conn, lease);
    waiter.settled = true;
    counters.inc('connlease_borrowed_total');
    waiter.resolve({
      id: lease.id,
      conn,
      release(options = {}) {
        // 幂等：重复还、租约已被回收，都直接吞掉。
        if (lease.released) {
          return;
        }
        if (borrowed.get(conn) !== lease) {
          lease.released = true;
          return;
        }
        lease.released = true;
        borrowed.delete(conn);
        counters.inc('connlease_returned_total');
        const broken = options.broken === true || driver.isBroken(conn);
        if (broken || closed) {
          if (broken) {
            closeConn(conn, true);
          } else {
            closeConn(conn, false);
          }
        } else {
          idle.push(conn);
        }
        pump();
        checkCloseComplete();
      },
    });
  }

  // 给一个排队者安排连接：先复用空闲的（借之前再验一次坏没坏），
  // 没有空闲且额度没满就新建。安排不了返回 false。
  function dispatch(waiter) {
    while (idle.length > 0 && driver.isBroken(idle[0])) {
      closeConn(idle.shift(), true);
    }
    if (idle.length > 0) {
      grant(waiter, idle.shift());
      return true;
    }
    if (liveCount() + creating < config.maxConnections) {
      creating += 1;
      driver
        .open()
        .then((conn) => {
          creating -= 1;
          counters.inc('connlease_created_total');
          if (closed) {
            // 关池途中才建成：直接关掉，不交出去。
            closeConn(conn, false);
            checkCloseComplete();
            return;
          }
          if (waiter.settled) {
            // 排队者已经超时走了：连接留下给后面的人。
            idle.push(conn);
            pump();
            return;
          }
          grant(waiter, conn);
          pump();
        })
        .catch((error) => {
          creating -= 1;
          if (!waiter.settled) {
            waiter.settled = true;
            waiter.reject(error);
          }
          // 额度还回去，后面排队的人可以再试。
          pump();
        });
      return true;
    }
    return false;
  }

  // 有任何变化（归还、新建成、建失败、超时退出）后，按 FIFO 安排排队者。
  function pump() {
    if (closed) {
      return;
    }
    while (waiters.length > 0) {
      const waiter = waiters[0];
      if (waiter.settled) {
        waiters.shift();
        continue;
      }
      if (!dispatch(waiter)) {
        break;
      }
      waiters.shift();
    }
  }

  function waitTimeout(waiter) {
    sleep(config.acquireTimeoutMs).then(() => {
      if (waiter.settled) {
        return;
      }
      const index = waiters.indexOf(waiter);
      if (index !== -1) {
        waiters.splice(index, 1);
      }
      waiter.settled = true;
      counters.inc('connlease_wait_timeout_total');
      waiter.reject(new AcquireTimeoutError());
      // 人走了位置就得让出来；额度若因此有变化，再安排后面的人。
      pump();
    });
  }

  // 定时扫描：借出去超过 leaseTimeoutMs 的当前租约，按坏连接回收。
  function reclaimExpired() {
    const nowValue = now();
    for (const [conn, lease] of borrowed) {
      if (nowValue < lease.deadline) {
        continue;
      }
      borrowed.delete(conn);
      lease.released = true;
      counters.inc('connlease_broken_total');
      counters.inc('connlease_lease_expired_total');
      closeConn(conn, false);
    }
    pump();
    checkCloseComplete();
  }

  async function reclaimLoop() {
    for (;;) {
      await sleep(config.reclaimIntervalMs);
      reclaimExpired();
      if (closed && outstandingCount() === 0) {
        return;
      }
    }
  }

  function checkCloseComplete() {
    if (
      closeStarted &&
      waiters.length === 0 &&
      outstandingCount() === 0
    ) {
      closeResolve();
    }
  }

  reclaimLoop();

  return {
    acquire() {
      counters.inc('connlease_acquire_total');
      if (closed) {
        return Promise.reject(new PoolClosedError());
      }
      return new Promise((resolve, reject) => {
        const waiter = { settled: false, resolve, reject };
        // 队列为空且眼下就能安排：直接给，不算进等待队列。
        if (waiters.length === 0 && dispatch(waiter)) {
          return;
        }
        if (waiters.length >= config.maxWaiters) {
          counters.inc('connlease_rejected_total');
          reject(new PoolExhaustedError());
          return;
        }
        counters.inc('connlease_waited_total');
        waiters.push(waiter);
        waitTimeout(waiter);
        pump();
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
      if (!closeStarted) {
        closeStarted = true;
        closed = true;
        // 排队的全部叫醒拒掉。
        for (const waiter of waiters.splice(0)) {
          if (!waiter.settled) {
            waiter.settled = true;
            waiter.reject(new PoolClosedError());
          }
        }
        // 空闲的立刻关；借出去的等还回来（或租约回收）再关。
        for (const conn of idle.splice(0)) {
          closeConn(conn, false);
        }
        checkCloseComplete();
      }
      return closePromise;
    },
  };
}
