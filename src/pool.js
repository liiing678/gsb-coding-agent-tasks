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
import { NotImplementedError } from './errors.js';

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
  void now;
  void sleep;
  return {
    acquire() {
      throw new NotImplementedError('createPool 还没有实现');
    },
    stats() {
      throw new NotImplementedError('createPool 还没有实现');
    },
    close() {
      throw new NotImplementedError('createPool 还没有实现');
    },
  };
}
