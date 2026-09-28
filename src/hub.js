// 这个文件就是要写的那块。现在它只会抛 NotImplementedError。
//
// createHub({ config, counters, now, sleep }) -> { subscribe(subscription), publish(topic, event), close(), stats() }
//   config   : configs/dev.json 里 eventpush 那一段（config.js 已经校验过），字段见 README
//   counters : src/counters.js 的计数器，名字见 README
//   now      : 取当前时间，默认 () => Date.now()
//   sleep    : 睡 ms 毫秒，默认 setTimeout；测试会换成假时钟
//
// subscribe / publish / close / stats 的语义见 README 的《接口》和《口径》。
// 帧怎么编码用 src/sse.js 的 formatFrame。
import { NotImplementedError } from './errors.js';

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
  void sleep;
  return {
    subscribe() {
      throw new NotImplementedError('createHub 还没有实现');
    },
    publish() {
      throw new NotImplementedError('createHub 还没有实现');
    },
    close() {
      throw new NotImplementedError('createHub 还没有实现');
    },
    stats() {
      throw new NotImplementedError('createHub 还没有实现');
    },
  };
}
