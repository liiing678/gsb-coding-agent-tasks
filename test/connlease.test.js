import assert from 'node:assert/strict';
import test from 'node:test';

import { createCounters } from '../src/counters.js';
import { AcquireTimeoutError, PoolClosedError, PoolExhaustedError } from '../src/errors.js';
import { createPool } from '../src/pool.js';
import { createFakeClock } from './support/fake-clock.js';
import { createFakeDriver } from './support/fake-driver.js';

// 用例自己的配置：连接数、超时都调小了，跑得快。
const BASE = {
  maxConnections: 3,
  acquireTimeoutMs: 1000,
  leaseTimeoutMs: 5000,
  maxWaiters: 4,
  reclaimIntervalMs: 100,
};

function setUp(config = {}) {
  const clock = createFakeClock();
  const driver = createFakeDriver();
  const counters = createCounters();
  const pool = createPool({
    config: { ...BASE, ...config },
    driver,
    counters,
    now: clock.now,
    sleep: clock.sleep,
  });
  return { pool, driver, counters, clock };
}

async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function rejectsWith(target, type) {
  try {
    await (typeof target === 'function' ? target() : target);
  } catch (err) {
    assert.ok(err instanceof type, `期望 ${type.name}，实际是 ${err && err.name}`);
    return err;
  }
  assert.fail(`期望抛 ${type.name}，结果没抛`);
}

test('还回去的连接会被复用，不是每次都新建', async () => {
  const { pool, driver, counters } = setUp();

  const first = await pool.acquire();
  await first.release();
  const second = await pool.acquire();

  assert.equal(second.conn, first.conn);
  assert.equal(driver.created, 1);
  assert.equal(counters.snapshot().connlease_created_total, 1);
  assert.equal(counters.snapshot().connlease_borrowed_total, 2);
  await second.release();
});

test('并发借出永远不超过 maxConnections', async () => {
  const { pool, driver } = setUp({ maxConnections: 3, maxWaiters: 20 });

  const pending = [];
  for (let i = 0; i < 10; i += 1) {
    pending.push(pool.acquire());
  }
  await flush();

  assert.equal(driver.created, 3);
  assert.equal(driver.liveMax(), 3);
  assert.equal(pool.stats().borrowed, 3);
  assert.equal(pool.stats().waiters, 7);

  const held = await Promise.all(pending.slice(0, 3));
  const order = [];
  const tail = (async () => {
    const collected = [];
    for (let i = 3; i < 10; i += 1) {
      if (collected.length === 3) {
        await collected.shift().release();
      }
      collected.push(await pending[i].then((lease) => {
        order.push(i);
        return lease;
      }));
    }
    for (const lease of collected) {
      await lease.release();
    }
    return order;
  })();

  for (const lease of held) {
    await lease.release();
  }

  assert.deepEqual(await tail, [3, 4, 5, 6, 7, 8, 9]);
  assert.equal(driver.liveMax(), 3);
  assert.equal(pool.stats().live, 3);
});

test('等的人按先来后到拿到连接', async () => {
  const { pool } = setUp({ maxConnections: 2, maxWaiters: 10 });

  const held = [await pool.acquire(), await pool.acquire()];
  const order = [];
  const waiting = [1, 2, 3].map((n) => pool.acquire().then((lease) => {
    order.push(n);
    return lease;
  }));
  await flush();
  assert.deepEqual(order, []);

  await held[0].release();
  const first = await waiting[0];
  assert.deepEqual(order, [1]);

  await held[1].release();
  const second = await waiting[1];
  assert.deepEqual(order, [1, 2]);

  await first.release();
  const third = await waiting[2];
  assert.deepEqual(order, [1, 2, 3]);

  await second.release();
  await third.release();
});

test('排队等到超时就放弃，不会占着后面的位置', async () => {
  const { pool, counters, clock } = setUp({ maxConnections: 1, acquireTimeoutMs: 300 });

  const held = await pool.acquire();
  const first = pool.acquire().then(
    (lease) => ({ lease }),
    (error) => ({ error }),
  );
  await flush();
  await clock.advance(200);
  const second = pool.acquire();
  await flush();
  await clock.advance(200);

  const { error: err } = await first;
  assert.ok(err instanceof AcquireTimeoutError, `实际是 ${err && err.name}`);
  assert.equal(err.code, 'acquire_timeout');
  assert.equal(counters.snapshot().connlease_wait_timeout_total, 1);

  await held.release();
  const lease = await second;
  assert.ok(lease.conn);
  await lease.release();
});

test('等待队列满了就直接拒', async () => {
  const { pool, counters } = setUp({ maxConnections: 1, maxWaiters: 2, acquireTimeoutMs: 5000 });

  const held = await pool.acquire();
  const waiting = [pool.acquire(), pool.acquire()];
  await flush();

  await rejectsWith(() => pool.acquire(), PoolExhaustedError);
  assert.equal(counters.snapshot().connlease_rejected_total, 1);
  await flush();

  await held.release();
  const first = await waiting[0];
  await first.release();
  const second = await waiting[1];
  await second.release();
});

test('借出去没人还，租约到点就被回收', async () => {
  const { pool, driver, counters, clock } = setUp({
    maxConnections: 1,
    leaseTimeoutMs: 300,
    reclaimIntervalMs: 50,
  });

  const lease = await pool.acquire();
  const conn = lease.conn;
  await clock.advance(400);
  await flush();

  assert.equal(driver.isLive(conn), false);
  assert.equal(counters.snapshot().connlease_lease_expired_total, 1);

  const next = await pool.acquire();
  assert.notEqual(next.conn, conn);
  await next.release();
});

test('已经还回来的连接，不会因为上一次的租约到点被销毁', async () => {
  const { pool, driver, counters, clock } = setUp({
    maxConnections: 1,
    leaseTimeoutMs: 300,
    reclaimIntervalMs: 50,
  });

  const first = await pool.acquire();
  await first.release();
  await clock.advance(400);
  await flush();

  assert.equal(driver.isLive(first.conn), true);
  assert.equal(counters.snapshot().connlease_lease_expired_total, 0);

  const second = await pool.acquire();
  assert.equal(second.conn, first.conn);
  await second.release();
});

test('还回来的时候说坏了，这条连接就销毁', async () => {
  const { pool, driver, counters } = setUp({ maxConnections: 2 });

  const first = await pool.acquire();
  await first.release({ broken: true });

  assert.equal(driver.isLive(first.conn), false);
  assert.equal(counters.snapshot().connlease_broken_total, 1);

  const second = await pool.acquire();
  assert.notEqual(second.conn, first.conn);
  await second.release();
  assert.equal(driver.closes.length, 1);
});

test('空闲连接在下游那边已经断了，就不会再借出去', async () => {
  const { pool, driver } = setUp({ maxConnections: 2 });

  const first = await pool.acquire();
  await first.release();
  driver.breakConn(first.conn);

  const second = await pool.acquire();
  assert.notEqual(second.conn, first.conn);
  assert.equal(driver.isLive(first.conn), false);
  await second.release();
});

test('关池：排队的被拒、空闲的关掉、借出去的等还回来', async () => {
  const { pool, driver } = setUp({ maxConnections: 1, acquireTimeoutMs: 5000 });

  const held = await pool.acquire();
  const waiter = pool.acquire().then(
    (lease) => ({ lease }),
    (error) => ({ error }),
  );
  await flush();

  const closing = pool.close();
  const waiterOutcome = await waiter;
  assert.ok(waiterOutcome.error instanceof PoolClosedError, `实际是 ${waiterOutcome.error && waiterOutcome.error.name}`);
  const err = await rejectsWith(() => pool.acquire(), PoolClosedError);
  assert.equal(err.code, 'pool_closed');

  let done = false;
  closing.then(() => {
    done = true;
  });
  await flush();
  assert.equal(done, false);
  assert.equal(pool.close(), closing);

  await held.release();
  await closing;
  assert.equal(driver.liveCount(), 0);
});

test('stats 看得出池子现在的样子，计数器就那几个', async () => {
  const { pool, counters } = setUp({ maxConnections: 2 });

  const lease = await pool.acquire();
  const busy = pool.stats();
  assert.equal(busy.live, 1);
  assert.equal(busy.idle, 0);
  assert.equal(busy.borrowed, 1);
  assert.equal(busy.creating, 0);
  assert.equal(busy.waiters, 0);
  assert.deepEqual(Object.keys(busy.counters), counters.names);

  await lease.release();
  const free = pool.stats();
  assert.equal(free.live, 1);
  assert.equal(free.idle, 1);
  assert.equal(free.borrowed, 0);
  assert.equal(counters.names.length, 9);
});
