import { createCounters } from '../../src/counters.js';
import { createHub } from '../../src/hub.js';
import { createFakeClock } from './fake-clock.js';

// 用例自己的配置：缓冲和窗口都调小了，跑得快。
export const BASE_CONFIG = {
  perConnBuffer: 2,
  defaultOverflowPolicy: 'drop_oldest',
  replayWindow: 4,
  maxSubscriptions: 3,
  drainTimeoutMs: 1000,
};

export function setUp({ config = {} } = {}) {
  const clock = createFakeClock();
  const counters = createCounters();
  const hub = createHub({
    config: { ...BASE_CONFIG, ...config },
    counters,
    now: clock.now,
    sleep: clock.sleep,
  });
  return { hub, counters, clock };
}

export function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

// 接帧的假连接：
//   auto = true  -> send 立刻返回，正常客户端
//   auto = false -> send 挂在那儿，等用例 release() 放行（慢客户端）
export function createSink({ auto = true } = {}) {
  const frames = [];
  const waiting = [];
  let closedReason = null;
  return {
    frames,
    get closedReason() {
      return closedReason;
    },
    ids: () => frames.map((frame) => parseFrame(frame).id),
    events: () => frames.map((frame) => parseFrame(frame).event),
    payloads: () => frames.map((frame) => parseFrame(frame).json),
    send(frame) {
      frames.push(frame);
      if (auto) return undefined;
      return new Promise((resolve) => waiting.push(resolve));
    },
    close(reason) {
      closedReason = reason;
    },
    release(count = 1) {
      for (let i = 0; i < count; i += 1) {
        const resolve = waiting.shift();
        if (resolve) resolve();
      }
    },
  };
}

export function parseFrame(frame) {
  const fields = { id: '', event: 'message', data: '' };
  for (const line of frame.split('\n')) {
    if (line.startsWith('id: ')) fields.id = line.slice(4);
    else if (line.startsWith('event: ')) fields.event = line.slice(7);
    else if (line.startsWith('data: ')) fields.data = line.slice(6);
  }
  return { ...fields, json: fields.data ? JSON.parse(fields.data) : null };
}
