// 事件中枢：订阅表、每连接队列与背压、断线补发窗口、关停排水。
//
// 关键不变式：
//   - seq 在 publish() 被调用的那一刻同步分配，先调先得，不被 await 插队；
//   - publish 只负责入队，绝不等任何客户端的发送；
//   - 每条订阅一个 FIFO 队列 + 一个发送循环，正在发的那一帧不占队列名额。
import { ClosingError, SubscriberLimitError } from './errors.js';
import { formatFrame } from './sse.js';

export function createHub({
  config,
  counters,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!config) {
    throw new Error('createHub 需要 config');
  }
  if (!counters) {
    throw new Error('createHub 需要 counters');
  }
  void now;

  const subscriptions = new Set();
  const replayBuffer = []; // { seq, topic, frame }，最旧的在前，越界从头丢
  let seq = 0;
  let nextSubscriptionId = 0;
  let closing = false;
  let closePromise = null;

  // 结束一条订阅：从订阅表摘掉、清空队列、回调一次 close(reason)。
  // count 只给服务端主动断开（overflow / send_failed / drain_timeout）计数。
  function disconnect(sub, reason, { count = true } = {}) {
    if (!sub.active) return;
    sub.active = false;
    subscriptions.delete(sub);
    sub.queue.length = 0;
    if (count) counters.inc('eventpush_disconnected_total');
    if (sub.drainResolve) sub.drainResolve();
    sub.close(reason);
  }

  // 发送循环：一条订阅同一时刻只跑一个；发完一帧（等 send 落定）再取下一帧。
  function pump(sub) {
    if (sub.pumping || !sub.active) return;
    sub.pumping = true;
    (async () => {
      while (sub.active && sub.queue.length > 0) {
        const frame = sub.queue.shift();
        sub.sending = true;
        try {
          await sub.send(frame);
          counters.inc('eventpush_delivered_total');
        } catch {
          disconnect(sub, 'send_failed');
          break;
        } finally {
          sub.sending = false;
        }
      }
      sub.pumping = false;
      if (sub.queue.length === 0 && sub.drainResolve) {
        sub.drainResolve();
      }
    })();
  }

  // 实时帧入队：满了按这条订阅的 overflowPolicy 走。
  function enqueueLive(sub, frame) {
    if (!sub.active) return;
    if (sub.queue.length >= config.perConnBuffer) {
      if (sub.policy === 'disconnect') {
        disconnect(sub, 'overflow');
        return;
      }
      sub.queue.shift();
      counters.inc('eventpush_dropped_total');
    }
    sub.queue.push(frame);
    pump(sub);
  }

  function subscribe(subscription) {
    if (closing) {
      counters.inc('eventpush_rejected_total');
      throw new ClosingError();
    }
    if (subscriptions.size >= config.maxSubscriptions) {
      counters.inc('eventpush_rejected_total');
      throw new SubscriberLimitError();
    }
    const sub = {
      id: ++nextSubscriptionId,
      topics: subscription.topics ?? [],
      policy: subscription.overflowPolicy ?? config.defaultOverflowPolicy,
      send: subscription.send,
      close: subscription.close ?? (() => {}),
      queue: [],
      active: true,
      pumping: false,
      sending: false,
      drainResolve: null,
    };
    subscriptions.add(sub);

    // 补发：同步排进队列，赶在订阅生效后的任何实时帧之前；不占 perConnBuffer 名额。
    if (subscription.lastEventId !== undefined && subscription.lastEventId !== null) {
      const requested = Number(subscription.lastEventId);
      const oldest = replayBuffer.length > 0 ? replayBuffer[0].seq : null;
      if (oldest !== null && oldest > requested + 1) {
        counters.inc('eventpush_replay_gap_total');
        sub.queue.push(formatFrame({ id: '', event: 'replay_gap', data: { requested, oldest } }));
      }
      for (const record of replayBuffer) {
        if (record.seq > requested && sub.topics.includes(record.topic)) {
          counters.inc('eventpush_replay_total');
          sub.queue.push(record.frame);
        }
      }
    }
    pump(sub);

    return {
      id: sub.id,
      topics: sub.topics,
      close(reason) {
        disconnect(sub, reason ?? 'client_gone', { count: false });
      },
    };
  }

  function publish(topic, event) {
    counters.inc('eventpush_published_total');
    if (closing) {
      counters.inc('eventpush_publish_rejected_total');
      return Promise.reject(new ClosingError());
    }
    seq += 1;
    const frame = formatFrame({
      id: String(seq),
      event: event && event.type ? event.type : 'message',
      data: event ? event.data : undefined,
    });
    replayBuffer.push({ seq, topic, frame });
    if (replayBuffer.length > config.replayWindow) {
      replayBuffer.shift();
    }
    for (const sub of subscriptions) {
      if (sub.topics.includes(topic)) {
        enqueueLive(sub, frame);
      }
    }
    return Promise.resolve({ topic, seq, id: String(seq) });
  }

  // 关停时的一条订阅：等队列写完，最多等 drainTimeoutMs，写不完就断开。
  async function drainSubscription(sub) {
    if (!sub.active) return;
    const drained = new Promise((resolve) => {
      sub.drainResolve = resolve;
    });
    if (sub.queue.length === 0 && !sub.sending) {
      sub.drainResolve();
    }
    let timedOut = false;
    await Promise.race([
      drained,
      sleep(config.drainTimeoutMs).then(() => {
        timedOut = true;
      }),
    ]);
    if (!sub.active) return;
    if (timedOut && (sub.queue.length > 0 || sub.sending)) {
      disconnect(sub, 'drain_timeout');
      return;
    }
    sub.active = false;
    subscriptions.delete(sub);
    if (sub.drainResolve) sub.drainResolve();
    sub.close('closed');
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = Promise.all(
      [...subscriptions].map((sub) => drainSubscription(sub)),
    ).then(() => {});
    return closePromise;
  }

  function stats() {
    let buffered = 0;
    for (const sub of subscriptions) {
      buffered += sub.queue.length;
    }
    return {
      subscriptions: subscriptions.size,
      buffered,
      oldestSeq: replayBuffer.length > 0 ? replayBuffer[0].seq : null,
      newestSeq: replayBuffer.length > 0 ? replayBuffer[replayBuffer.length - 1].seq : null,
      counters: counters.snapshot(),
    };
  }

  return {
    subscribe,
    publish,
    close,
    stats,
  };
}
