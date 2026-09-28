// 共享存储：线上是 Redis，这里把它按我们会用到的那几条命令一比一模拟出来。
//
// 所有方法都是异步的（真实环境每次都要走网络）。标了"原子"的那几条，并发下也不会互相
// 插进来——你就当成一条 Redis 命令用。
//
// 值一律是字符串；ttlMs 不给（或者给 0）就是不过期。
import { StoreDownError } from './errors.js';

export function createSharedStore({ now = () => Date.now() } = {}) {
  const data = new Map(); // key -> { value, expiresAt }
  let down = false;

  function write(key, value, ttlMs) {
    if (typeof value !== 'string') {
      throw new TypeError('共享存储只存字符串');
    }
    data.set(key, { value, expiresAt: ttlMs ? now() + ttlMs : null });
  }

  function live(key) {
    const item = data.get(key);
    if (!item) return null;
    if (item.expiresAt !== null && item.expiresAt <= now()) {
      data.delete(key);
      return null;
    }
    return item;
  }

  function guard() {
    if (down) throw new StoreDownError();
  }

  return {
    async get(key) {
      guard();
      const item = live(key);
      return item ? item.value : null;
    },
    async set(key, value, ttlMs) {
      guard();
      write(key, value, ttlMs);
    },
    async del(key) {
      guard();
      return data.delete(key);
    },
    async setIfAbsent(key, value, ttlMs) {
      guard();
      if (live(key)) return false;
      write(key, value, ttlMs);
      return true;
    },
    async compareAndSet(key, expected, next, ttlMs) {
      guard();
      const item = live(key);
      if ((item ? item.value : null) !== expected) return false;
      write(key, next, ttlMs);
      return true;
    },
    async compareAndDel(key, expected) {
      guard();
      const item = live(key);
      if ((item ? item.value : null) !== expected) return false;
      data.delete(key);
      return true;
    },
    async incr(key, by = 1) {
      guard();
      const item = live(key);
      const next = (item ? Number(item.value) : 0) + by;
      write(key, String(next), 0);
      return next;
    },
    // 下面两个是给测试和演示用的，实现里别用。
    setDown(flag) {
      down = Boolean(flag);
    },
    dump() {
      const out = {};
      for (const key of [...data.keys()]) {
        const item = live(key);
        if (item) out[key] = item.value;
      }
      return out;
    },
  };
}
