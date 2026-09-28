// 这个文件就是要写的那块：现在是空的，两个入口都只会抛 NotImplementedError。
//
// parseCron(expression, timeZone) -> { expression, timeZone, next(afterMs) }
// createScheduler({ config, counters, now, sleep }) -> { add(job), start(), stop(), stats() }
//
// config   : configs/dev.json 里 tickwheel 那一段（config.js 已经校验过），字段见 README
// counters : lib/counters.js 的计数器，名字见 README
// now      : 取当前时间，默认 () => Date.now()
// sleep    : 等 ms 毫秒，默认 setTimeout；演示和用例会换成手动时钟
//
// cron 语法、时区和夏令时的规矩、到点了怎么触发、stop 怎么收尾，都在 README 的《口径》里。
import { NotImplementedError } from './errors.js';

export function parseCron(expression, timeZone) {
  void expression;
  void timeZone;
  throw new NotImplementedError('parseCron 还没有实现');
}

export function createScheduler({
  config,
  counters,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!config) {
    throw new Error('createScheduler 需要 config');
  }
  if (!counters) {
    throw new Error('createScheduler 需要 counters');
  }
  void now;
  void sleep;
  return {
    add() {
      throw new NotImplementedError('createScheduler 还没有实现');
    },
    start() {
      throw new NotImplementedError('createScheduler 还没有实现');
    },
    stop() {
      throw new NotImplementedError('createScheduler 还没有实现');
    },
    stats() {
      throw new NotImplementedError('createScheduler 还没有实现');
    },
  };
}
