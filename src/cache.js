// 这个文件就是要写的那块。现在它只会抛 NotImplementedError。
//
// createCache({ config, counters, store, loader, now, sleep }) -> { get(key, options), invalidateTag(tag), stats() }
//   config   : configs/dev.json 里 cache 那一段（config.js 已经校验过），字段见 README
//   counters : src/counters.js 的计数器，名字见 README
//   store    : 共享存储（src/shared-store.js）。两个实例传同一个 store 就是多实例共享一份
//   loader   : 回源函数，(key) => { found: true, value, ttlMs? } | { found: false }
//   now      : 取当前时间，默认 () => Date.now()
//   sleep    : 睡 ms 毫秒，默认 setTimeout；测试会换成假时钟
//
// get(key, { tags }) / invalidateTag(tag) / stats() 的语义见 README 的《接口》和《口径》。
import { NotImplementedError } from './errors.js';

export function createCache({
  config,
  counters,
  store,
  loader,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!config) {
    throw new Error('createCache 需要 config');
  }
  if (!counters) {
    throw new Error('createCache 需要 counters');
  }
  if (!store) {
    throw new Error('createCache 需要 store');
  }
  if (!loader) {
    throw new Error('createCache 需要 loader');
  }
  void now;
  void sleep;
  return {
    async get() {
      throw new NotImplementedError('createCache 还没有实现');
    },
    async invalidateTag() {
      throw new NotImplementedError('createCache 还没有实现');
    },
    stats() {
      throw new NotImplementedError('createCache 还没有实现');
    },
  };
}
