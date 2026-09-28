import assert from 'node:assert/strict';
import test from 'node:test';

import { createSink, setUp, tick } from './support/harness.js';

const orders = { topics: ['orders'] };

test('订阅之后按发布顺序收到帧', async () => {
  const { hub, counters } = setUp();
  const sink = createSink();
  hub.subscribe({ ...orders, send: sink.send, close: sink.close });

  await hub.publish('orders', { type: 'order.created', data: { id: 7 } });
  await hub.publish('orders', { type: 'order.paid', data: { id: 7 } });
  await tick();

  assert.deepEqual(sink.ids(), ['1', '2']);
  assert.deepEqual(sink.events(), ['order.created', 'order.paid']);
  assert.deepEqual(sink.payloads(), [{ id: 7 }, { id: 7 }]);
  const snapshot = counters.snapshot();
  assert.equal(snapshot.eventpush_published_total, 2);
  assert.equal(snapshot.eventpush_delivered_total, 2);
});

test('只收自己订阅的 topic', async () => {
  const { hub } = setUp();
  const sink = createSink();
  hub.subscribe({ ...orders, send: sink.send, close: sink.close });

  await hub.publish('orders', { type: 'order.created', data: { where: 'orders' } });
  await hub.publish('payments', { type: 'payment.ok', data: { where: 'payments' } });
  await tick();

  assert.deepEqual(sink.ids(), ['1']);
  assert.deepEqual(sink.payloads(), [{ where: 'orders' }]);
});

test('同一个 topic 的多个订阅者都收到', async () => {
  const { hub } = setUp();
  const left = createSink();
  const right = createSink();
  hub.subscribe({ ...orders, send: left.send, close: left.close });
  hub.subscribe({ ...orders, send: right.send, close: right.close });

  await hub.publish('orders', { type: 'order.created', data: { id: 1 } });
  await tick();

  assert.deepEqual(left.ids(), ['1']);
  assert.deepEqual(right.ids(), ['1']);
});

test('慢订阅者：缓冲满了丢最旧的，不拖累别人', async () => {
  const { hub, counters } = setUp(); // perConnBuffer = 2
  const slow = createSink({ auto: false });
  const fast = createSink();
  hub.subscribe({ ...orders, send: slow.send, close: slow.close });
  hub.subscribe({ ...orders, send: fast.send, close: fast.close });

  for (let i = 1; i <= 5; i += 1) {
    await hub.publish('orders', { type: 'tick', data: { i } });
  }
  await tick();

  assert.deepEqual(fast.ids(), ['1', '2', '3', '4', '5']); // 慢的那个没拖累它
  assert.deepEqual(slow.ids(), ['1']); // 第一帧还在发，后面的在队列里排着
  assert.equal(counters.snapshot().eventpush_dropped_total, 2); // 2、3 这两帧被挤掉了

  slow.release(1);
  await tick();
  assert.deepEqual(slow.ids(), ['1', '4']);
  slow.release(1);
  await tick();
  assert.deepEqual(slow.ids(), ['1', '4', '5']);
});

test('overflowPolicy=disconnect：缓冲满了直接断开这条订阅', async () => {
  const { hub, counters } = setUp();
  const slow = createSink({ auto: false });
  hub.subscribe({
    ...orders,
    overflowPolicy: 'disconnect',
    send: slow.send,
    close: slow.close,
  });

  for (let i = 1; i <= 5; i += 1) {
    await hub.publish('orders', { type: 'tick', data: { i } });
  }
  await tick();

  assert.equal(slow.closedReason, 'overflow');
  assert.equal(counters.snapshot().eventpush_disconnected_total, 1);

  await hub.publish('orders', { type: 'tick', data: { i: 6 } });
  await tick();
  assert.deepEqual(slow.ids(), ['1']); // 断开之后不再给它发
});

test('并发 publish 的 seq 按调用顺序，收到的顺序也一致', async () => {
  const { hub } = setUp();
  const sink = createSink();
  hub.subscribe({ ...orders, send: sink.send, close: sink.close });

  const results = await Promise.all([
    hub.publish('orders', { type: 'tick', data: { n: 1 } }),
    hub.publish('orders', { type: 'tick', data: { n: 2 } }),
    hub.publish('orders', { type: 'tick', data: { n: 3 } }),
  ]);
  await tick();

  assert.deepEqual(results.map((item) => item.seq), [1, 2, 3]);
  assert.deepEqual(sink.ids(), ['1', '2', '3']);
  assert.deepEqual(sink.payloads().map((data) => data.n), [1, 2, 3]);
});

test('带 Last-Event-ID 重连：窗口里的按原顺序补一遍，不重复', async () => {
  const { hub, counters } = setUp();
  for (let i = 1; i <= 3; i += 1) {
    await hub.publish('orders', { type: 'tick', data: { i } });
  }

  const sink = createSink();
  hub.subscribe({ ...orders, lastEventId: '1', send: sink.send, close: sink.close });
  await tick();

  assert.deepEqual(sink.ids(), ['2', '3']);
  assert.deepEqual(sink.payloads().map((data) => data.i), [2, 3]);
  assert.equal(counters.snapshot().eventpush_replay_total, 2);
});

test('补发期间新发布的事件排在补发后面', async () => {
  const { hub } = setUp();
  for (let i = 1; i <= 3; i += 1) {
    await hub.publish('orders', { type: 'tick', data: { i } });
  }

  const sink = createSink();
  hub.subscribe({ ...orders, lastEventId: '1', send: sink.send, close: sink.close });
  await hub.publish('orders', { type: 'live', data: { i: 4 } });
  await tick();

  assert.deepEqual(sink.ids(), ['2', '3', '4']);
  assert.deepEqual(sink.payloads().map((data) => data.i), [2, 3, 4]);
  assert.equal(sink.events()[2], 'live');
});

test('Last-Event-ID 太老：先给一帧 replay_gap，再补窗口里有的', async () => {
  const { hub, counters } = setUp({ config: { replayWindow: 3 } });
  for (let i = 1; i <= 5; i += 1) {
    await hub.publish('orders', { type: 'tick', data: { i } });
  }

  const sink = createSink();
  hub.subscribe({ ...orders, lastEventId: '1', send: sink.send, close: sink.close });
  await tick();

  assert.deepEqual(sink.events(), ['replay_gap', 'tick', 'tick', 'tick']);
  assert.deepEqual(sink.payloads()[0], { requested: 1, oldest: 3 });
  assert.deepEqual(sink.ids().slice(1), ['3', '4', '5']);
  assert.equal(counters.snapshot().eventpush_replay_gap_total, 1);
});

test('关闭：publish 被拒、队列写完、close 幂等、之后订阅也被拒', async () => {
  const { hub, counters } = setUp();
  const sink = createSink();
  hub.subscribe({ ...orders, send: sink.send, close: sink.close });
  await hub.publish('orders', { type: 'tick', data: { i: 1 } });

  const closing = hub.close();
  await assert.rejects(hub.publish('orders', { type: 'tick', data: { i: 2 } }), (error) => error.code === 'closing');
  assert.throws(
    () => hub.subscribe({ ...orders, send: sink.send, close: sink.close }),
    (error) => error.code === 'closing',
  );

  await closing;
  await tick();
  assert.deepEqual(sink.ids(), ['1']); // 关闭前排队的那一帧照样写完了
  assert.equal(sink.closedReason, 'closed');
  assert.equal(counters.snapshot().eventpush_publish_rejected_total, 1);
  assert.equal(counters.snapshot().eventpush_rejected_total, 1);
  assert.equal(hub.stats().subscriptions, 0);
  await hub.close(); // 幂等，直接返回
});

test('drain 超时：写不完的订阅被断开，close 照样返回', async () => {
  const { hub, counters, clock } = setUp();
  const slow = createSink({ auto: false });
  hub.subscribe({ ...orders, send: slow.send, close: slow.close });
  await hub.publish('orders', { type: 'tick', data: { i: 1 } });
  await hub.publish('orders', { type: 'tick', data: { i: 2 } });
  await tick();

  const closing = hub.close();
  await tick();
  await clock.advance(1000); // drainTimeoutMs
  await tick();
  await closing;

  assert.equal(slow.closedReason, 'drain_timeout');
  assert.equal(counters.snapshot().eventpush_disconnected_total, 1);
});

test('订阅数到上限：新的订阅被拒', async () => {
  const { hub, counters } = setUp({ config: { maxSubscriptions: 2 } });
  for (const sink of [createSink(), createSink()]) {
    hub.subscribe({ ...orders, send: sink.send, close: sink.close });
  }

  assert.throws(
    () => hub.subscribe({ ...orders, send: () => {}, close: () => {} }),
    (error) => error.code === 'too_many_subscribers',
  );
  assert.equal(counters.snapshot().eventpush_rejected_total, 1);
});

test('send 抛错：断开这条订阅，别人不受影响', async () => {
  const { hub, counters } = setUp();
  const broken = createSink();
  const fine = createSink();
  broken.send = () => {
    throw new Error('socket reset');
  };
  hub.subscribe({ ...orders, send: broken.send, close: broken.close });
  hub.subscribe({ ...orders, send: fine.send, close: fine.close });

  await hub.publish('orders', { type: 'tick', data: { i: 1 } });
  await tick();

  assert.equal(broken.closedReason, 'send_failed');
  assert.equal(counters.snapshot().eventpush_disconnected_total, 1);
  assert.deepEqual(fine.ids(), ['1']);
});
