import assert from 'node:assert/strict';
import test from 'node:test';

import { delay, post, startApp } from './support/app.js';
import { createDeferred } from './support/deferred.js';
import { createFakeClock } from './support/fake-clock.js';

// 每条用例只在验一件事，具体口径看 README 的「幂等口径」。

// 没有 key 的请求不进幂等，每次都真的执行；key 太长直接 400，也不执行。
test('没有 key 和 key 太长都不进幂等', async () => {
  let calls = 0;
  const app = await startApp({
    handler: async (req, recorder) => {
      calls += 1;
      recorder.status(200);
      recorder.end(`n=${calls}`);
    },
  });
  try {
    await post(app.base, undefined, 'a');
    await post(app.base, undefined, 'a');
    const tooLong = await post(app.base, 'k'.repeat(65), 'a');

    assert.equal(calls, 2);
    assert.equal(tooLong.status, 400);
    assert.deepEqual(await tooLong.json(), { error: 'invalid_idempotency_key' });

    const snapshot = app.metrics.snapshot();
    assert.equal(snapshot.idem_passthrough_total, 2);
    assert.equal(snapshot.idem_rejected_total, 1);
  } finally {
    await app.close();
  }
});

// 同 key 同 body：第一次真执行，第二次拿缓存回放，handler 不能再被调用。
// 回放的响应只带白名单里的头（set-cookie 不该跟着回来）。
test('同 key 同 body 的第二次请求直接回放', async () => {
  let calls = 0;
  const app = await startApp({
    handler: async (req, recorder) => {
      calls += 1;
      recorder.status(201);
      recorder.setHeader('content-type', 'application/json');
      recorder.setHeader('set-cookie', 'seq=1; Path=/');
      recorder.end('{"ok":true}');
    },
  });
  try {
    const first = await post(app.base, 'k1', '{"a":1}');
    const second = await post(app.base, 'k1', '{"a":1}');

    assert.equal(calls, 1);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(await second.text(), await first.text());
    assert.equal(first.headers.get('x-idem-replay'), null);
    assert.equal(second.headers.get('x-idem-replay'), 'true');
    assert.equal(second.headers.get('content-type'), 'application/json');
    assert.equal(second.headers.get('set-cookie'), null);

    const snapshot = app.metrics.snapshot();
    assert.equal(snapshot.idem_executed_total, 1);
    assert.equal(snapshot.idem_replayed_total, 1);
  } finally {
    await app.close();
  }
});

// 同 key 并发挤在一起：handler 只能被执行一次，后来那些挂上去等同一份结果。
test('同 key 并发时只执行一次，其它请求等同一份结果', async () => {
  const gate = createDeferred();
  let calls = 0;
  const app = await startApp({
    handler: async (req, recorder) => {
      calls += 1;
      await gate.promise;
      recorder.status(200);
      recorder.end(`body-${calls}`);
    },
  });
  try {
    const first = post(app.base, 'k2', 'x');
    await delay(50);
    const waiters = [post(app.base, 'k2', 'x'), post(app.base, 'k2', 'x'), post(app.base, 'k2', 'x')];
    await delay(50);
    gate.resolve();

    const responses = await Promise.all([first, ...waiters]);
    const bodies = await Promise.all(responses.map((response) => response.text()));

    assert.equal(calls, 1);
    assert.deepEqual(bodies, ['body-1', 'body-1', 'body-1', 'body-1']);
    assert.equal(app.metrics.snapshot().idem_waited_total, 3);
  } finally {
    await app.close();
  }
});

// 同一个 key 换了 body 就是另一件事：当场 409，不排队、也不复用别人的结果。
test('同 key 不同 body 当场 409，就算上一次还在跑', async () => {
  const gate = createDeferred();
  let calls = 0;
  const app = await startApp({
    handler: async (req, recorder) => {
      calls += 1;
      await gate.promise;
      recorder.status(201);
      recorder.end('done');
    },
  });
  try {
    const first = post(app.base, 'k3', '{"a":1}');
    await delay(50);
    const conflict = await post(app.base, 'k3', '{"a":2}');
    gate.resolve();
    await first;

    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'idempotency_key_reuse' });
    assert.equal(calls, 1);
    assert.equal(app.metrics.snapshot().idem_conflicts_total, 1);
  } finally {
    await app.close();
  }
});

// 缓存过了 TTL 就不能再回放，同键同指纹再进来要重新执行。
test('缓存过了 TTL 之后再进来要重新执行', async () => {
  const clock = createFakeClock();
  let calls = 0;
  const app = await startApp({
    now: clock.now,
    idempotency: { ttlMs: 1000 },
    handler: async (req, recorder) => {
      calls += 1;
      recorder.status(200);
      recorder.end(`n=${calls}`);
    },
  });
  try {
    await post(app.base, 'k4', 'x');
    const replay = await post(app.base, 'k4', 'x');
    assert.equal(replay.headers.get('x-idem-replay'), 'true');

    clock.advance(1001);
    const again = await post(app.base, 'k4', 'x');

    assert.equal(again.headers.get('x-idem-replay'), null);
    assert.equal(await again.text(), 'n=2');
    assert.equal(calls, 2);
  } finally {
    await app.close();
  }
});

// 一次执行跑得比 TTL 还久时，等在飞执行上的请求仍然等它，不能自己再跑一遍。
test('执行时间超过 TTL 时，等在上面的请求不会重跑一遍', async () => {
  const clock = createFakeClock();
  const gate = createDeferred();
  let calls = 0;
  const app = await startApp({
    now: clock.now,
    idempotency: { ttlMs: 1000 },
    handler: async (req, recorder) => {
      calls += 1;
      await gate.promise;
      recorder.status(200);
      recorder.end('slow');
    },
  });
  try {
    const first = post(app.base, 'k5', 'x');
    await delay(50);
    clock.advance(5000);
    const waiter = post(app.base, 'k5', 'x');
    await delay(50);
    gate.resolve();

    const [a, b] = await Promise.all([first, waiter]);
    assert.equal(calls, 1);
    assert.equal(await a.text(), 'slow');
    assert.equal(await b.text(), 'slow');
    assert.equal(app.metrics.snapshot().idem_waited_total, 1);
  } finally {
    await app.close();
  }
});

// handler 挂了：发起者和等待者拿到同样的 500，这次结果不缓存，后面会重新执行。
test('handler 抛错时不缓存，等待者拿到同样的 500', async () => {
  const gate = createDeferred();
  let calls = 0;
  const app = await startApp({
    handler: async () => {
      calls += 1;
      await gate.promise;
      throw new Error('boom');
    },
  });
  try {
    const first = post(app.base, 'k6', 'x');
    await delay(50);
    const waiter = post(app.base, 'k6', 'x');
    await delay(50);
    gate.resolve();

    const [a, b] = await Promise.all([first, waiter]);
    assert.equal(a.status, 500);
    assert.equal(b.status, 500);
    assert.deepEqual(await a.json(), { error: 'handler_failed' });
    assert.deepEqual(await b.json(), { error: 'handler_failed' });

    const again = await post(app.base, 'k6', 'x');
    assert.equal(again.status, 500);
    assert.equal(calls, 2);
  } finally {
    await app.close();
  }
});

// 缓存条目到上限就淘汰最久没用过的那个；回放一次也算"用过"。
test('缓存条目到上限时淘汰最久没用的那个', async () => {
  const clock = createFakeClock();
  const calls = new Map();
  const app = await startApp({
    now: clock.now,
    idempotency: { maxEntries: 2 },
    handler: async (req, recorder) => {
      const key = req.headers['idempotency-key'];
      calls.set(key, (calls.get(key) ?? 0) + 1);
      recorder.status(200);
      recorder.end(key);
    },
  });
  try {
    await post(app.base, 'a', 'x');
    clock.advance(10);
    await post(app.base, 'b', 'x');
    clock.advance(10);
    await post(app.base, 'a', 'x'); // a 被用过，变新
    clock.advance(10);
    await post(app.base, 'c', 'x'); // 挤掉最久没用过的 b
    clock.advance(10);

    const aAgain = await post(app.base, 'a', 'x');
    assert.equal(aAgain.headers.get('x-idem-replay'), 'true');
    assert.equal(calls.get('a'), 1);
    clock.advance(10);

    const bAgain = await post(app.base, 'b', 'x');
    assert.equal(bAgain.headers.get('x-idem-replay'), null);
    assert.equal(calls.get('b'), 2);
    assert.ok(app.metrics.snapshot().idem_evicted_total >= 1);
  } finally {
    await app.close();
  }
});

// 挂在同一个执行上等的人太多：超过上限的直接 503，不排队。
test('等在同一次执行上的人超过上限时回 503', async () => {
  const gate = createDeferred();
  const app = await startApp({
    idempotency: { maxWaiters: 1 },
    handler: async (req, recorder) => {
      await gate.promise;
      recorder.status(200);
      recorder.end('ok');
    },
  });
  try {
    const first = post(app.base, 'k7', 'x');
    await delay(50);
    const waiter = post(app.base, 'k7', 'x');
    await delay(50);
    const rejected = await post(app.base, 'k7', 'x');

    assert.equal(rejected.status, 503);
    assert.deepEqual(await rejected.json(), { error: 'too_many_waiters' });

    gate.resolve();
    assert.equal((await first).status, 200);
    assert.equal((await waiter).status, 200);
    assert.ok(app.metrics.snapshot().idem_rejected_total >= 1);
  } finally {
    await app.close();
  }
});

// 发起这次执行的客户端断了，执行不能跟着断——还有人等着；
// 结果照常缓存，只是写回失败，计一次 idem_aborted_total。
test('首个请求的客户端断开时，等待者照样拿到结果', async () => {
  const gate = createDeferred();
  let calls = 0;
  const app = await startApp({
    handler: async (req, recorder) => {
      calls += 1;
      await gate.promise;
      recorder.status(201);
      recorder.end('done');
    },
  });
  try {
    const controller = new AbortController();
    const abandoned = fetch(`${app.base}/write`, {
      method: 'POST',
      headers: { 'idempotency-key': 'k8' },
      body: 'x',
      signal: controller.signal,
    });
    await delay(50);
    const waiter = post(app.base, 'k8', 'x');
    await delay(50);
    controller.abort();
    await abandoned.catch(() => {});
    await delay(50);
    gate.resolve();

    const result = await waiter;
    assert.equal(result.status, 201);
    assert.equal(await result.text(), 'done');
    assert.equal(calls, 1);
    await delay(20);
    assert.equal(app.metrics.snapshot().idem_aborted_total, 1);
  } finally {
    await app.close();
  }
});
