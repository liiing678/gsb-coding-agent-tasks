// createHub({ config, counters, now, sleep }) -> { subscribe, publish, close, stats }
//
// 结构：每条订阅一个队列 + 一个发送循环；publish 只负责分配 seq、入 replay 窗口、
// 把帧塞进各订阅的队列，从来不等任何客户端。语义细节见 README 的《接口》和《口径》。
import { ClosingError, SubscriberLimitError } from './errors.js';
import { formatFrame } from './sse.js';

const POLICIES = ['drop_oldest', 'disconnect'];

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
  void now; // 目前没有地方要取时间戳，drain 计时走注入的 sleep

  const subscriptions = new Set();
  const replayBuffer = []; // 最近 replayWindow 条：{ seq, topic, frame }
  let lastSeq = 0;
  let nextSubscriptionId = 0;
  let closing = false;
  let closePromise = null;

  // 结束一条订阅：清队列、移出集合、回调一次 close(reason)。
  // countDisconnect 为 true 时是服务端主动断开，要计 disconnected。
  function terminate(sub, reason, countDisconnect) {
    if (sub.closed) return;
    sub.closed = true;
    sub.queue.length = 0;
    subscriptions.delete(sub);
    if (countDisconnect) {
      counters.inc('eventpush_disconnected_total');
    }
    if (sub.drainResolve) {
      sub.drainResolve();
    }
    try {
      sub.onClose(reason);
    } catch {
      // 订阅方自己的 close 回调出问题，不能影响 hub 和其他订阅
    }
  }

  function notifyDrained(sub) {
    if (!sub.closed && !sub.pumpRunning && sub.queue.length === 0 && sub.drainResolve) {
      sub.drainResolve();
    }
  }

  // 发送循环：一次一帧，send 返回 promise 就等它；抛错或 reject 就断开这条订阅。
  function ensurePump(sub) {
    if (sub.pumpRunning || sub.closed) return;
    sub.pumpRunning = true;
    (async () => {
      while (!sub.closed && sub.queue.length > 0) {
        const item = sub.queue.shift();
        try {
          await sub.send(item.frame);
          counters.inc('eventpush_delivered_total');
          if (item.kind === 'replay') {
            counters.inc('eventpush_replay_total');
          } else if (item.kind === 'gap') {
            counters.inc('eventpush_replay_gap_total');
          }
        } catch {
          terminate(sub, 'send_failed', true);
          break;
        }
      }
      sub.pumpRunning = false;
      notifyDrained(sub);
    })();
  }

  // 入队。replay 帧（补发 + replay_gap）不受 perConnBuffer 限制；
  // 实时帧满了按这条订阅的 overflowPolicy 走。正在发的那帧不在队列里，不会被丢。
  function enqueue(sub, item, { replay = false } = {}) {
    if (sub.closed) return;
    if (!replay && sub.queue.length >= config.perConnBuffer) {
      if (sub.overflowPolicy === 'disconnect') {
        terminate(sub, 'overflow', true);
        return;
      }
      sub.queue.shift();
      counters.inc('eventpush_dropped_total');
    }
    sub.queue.push(item);
    ensurePump(sub);
  }

  // 同步生效：补发帧在这里就排进队列，订阅和补发之间不留缝。
  function subscribe({ topics = [], lastEventId, overflowPolicy, send, close: onClose } = {}) {
    if (closing) {
      counters.inc('eventpush_rejected_total');
      throw new ClosingError();
    }
    if (subscriptions.size >= config.maxSubscriptions) {
      counters.inc('eventpush_rejected_total');
      throw new SubscriberLimitError();
    }

    nextSubscriptionId += 1;
    const sub = {
      id: nextSubscriptionId,
      topics: new Set(topics),
      overflowPolicy: POLICIES.includes(overflowPolicy) ? overflowPolicy : config.defaultOverflowPolicy,
      send,
      onClose,
      queue: [],
      pumpRunning: false,
      closed: false,
      drainResolve: null,
    };
    subscriptions.add(sub);

    if (lastEventId !== undefined && lastEventId !== null && lastEventId !== '') {
      const requested = Number(lastEventId);
      if (Number.isFinite(requested) && replayBuffer.length > 0) {
        const oldest = replayBuffer[0].seq;
        if (requested + 1 < oldest) {
          // 中间已经缺了一段：先说清楚，再把窗口里有的补上
          enqueue(sub, {
            kind: 'gap',
            frame: formatFrame({
              id: String(requested),
              event: 'replay_gap',
              data: { requested, oldest },
            }),
          }, { replay: true });
        }
        for (const entry of replayBuffer) {
          if (entry.seq > requested && sub.topics.has(entry.topic)) {
            enqueue(sub, { kind: 'replay', frame: entry.frame }, { replay: true });
          }
        }
      }
    }

    return {
      id: sub.id,
      topics: [...sub.topics],
      close(reason = 'client_gone') {
        terminate(sub, reason, false); // 客户端自己断开，不算服务端断开
      },
    };
  }

  // seq 在这一刻同步分配，先调号小后调号大；只入队，不等任何客户端。
  function publish(topic, event) {
    if (closing) {
      counters.inc('eventpush_publish_rejected_total');
      return Promise.reject(new ClosingError());
    }
    lastSeq += 1;
    counters.inc('eventpush_published_total');
    const seq = lastSeq;
    const { type, data } = event ?? {};
    const frame = formatFrame({ id: String(seq), event: type || 'message', data });

    replayBuffer.push({ seq, topic, frame });
    while (replayBuffer.length > config.replayWindow) {
      replayBuffer.shift();
    }

    for (const sub of subscriptions) {
      if (sub.topics.has(topic)) {
        enqueue(sub, { kind: 'live', frame });
      }
    }
    return Promise.resolve({ topic, seq, id: String(seq) });
  }

  // 不再收新订阅/新发布；每条订阅最多等 drainTimeoutMs 把队列写完，
  // 写不完就断开。所有订阅处理完才 resolve；重复调用返回同一个 promise。
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const drains = [...subscriptions].map(async (sub) => {
        const drained = new Promise((resolve) => {
          sub.drainResolve = resolve;
        });
        notifyDrained(sub);
        const outcome = await Promise.race([
          drained.then(() => 'drained'),
          sleep(config.drainTimeoutMs).then(() => 'timeout'),
        ]);
        if (outcome === 'timeout') {
          terminate(sub, 'drain_timeout', true);
        } else {
          terminate(sub, 'closed', false);
        }
      });
      await Promise.all(drains);
    })();
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
      oldestSeq: replayBuffer.length > 0 ? replayBuffer[0].seq : 0,
      newestSeq: replayBuffer.length > 0 ? replayBuffer[replayBuffer.length - 1].seq : 0,
      counters: counters.snapshot(),
    };
  }

  return { subscribe, publish, close, stats };
}
