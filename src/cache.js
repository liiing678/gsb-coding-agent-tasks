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
import { CacheUnavailableError, StoreDownError } from './errors.js';

const ENTRY_PREFIX = 'cache:';
const GEN_PREFIX = 'cache:gen:';
const LOCK_PREFIX = 'cache:lock:';
// 全局锁 token 序号：本地自增两个实例会撞，用共享存储 incr 拿全局唯一值。
const LOCK_TOKEN_KEY = 'cache:locktoken';

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

  // 本实例正在回源的 key -> 同一次回源的 Promise，同实例并发只真回源一次。
  const inflight = new Map();

  function isStoreDown(error) {
    return error instanceof StoreDownError;
  }

  // 读一批 tag 当前的世代：没失效过就是 null（存储里没有这个 key）。
  async function readGenerations(tags) {
    const generations = {};
    await Promise.all(
      tags.map(async (tag) => {
        generations[tag] = await store.get(GEN_PREFIX + tag);
      }),
    );
    return generations;
  }

  function generationsEqual(snapshot, current) {
    return Object.keys(snapshot).every((tag) => {
      const left = snapshot[tag] ?? null;
      const right = current[tag] ?? null;
      return left === right;
    });
  }

  // 读缓存条目并按条目里记着的 tag 世代做命中判定。
  // 命中时 hit=true，value 为条目值（负缓存条目是 null）。
  async function readValidEntry(key) {
    const raw = await store.get(ENTRY_PREFIX + key);
    if (raw === null) {
      return { hit: false };
    }
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      return { hit: false };
    }
    const snapshot = entry.gens ?? {};
    const current = await readGenerations(Object.keys(snapshot));
    if (!generationsEqual(snapshot, current)) {
      return { hit: false };
    }
    return { hit: true, value: entry.neg ? null : entry.v };
  }

  // 回源（抛错时计数并原样抛出），返回给调用方的值：found:false 是 null。
  async function callOrigin(key) {
    let result;
    try {
      result = await loader(key);
    } catch (error) {
      counters.inc('cache_load_errors_total');
      throw error;
    }
    return result && result.found === false ? null : result.value;
  }

  // 共享存储在回源前就不可用：按 failMode 决定降级直连还是快速失败。
  async function originWithoutCache(key) {
    if (config.failMode === 'fail_fast') {
      throw new CacheUnavailableError();
    }
    counters.inc('cache_loads_total');
    counters.inc('cache_degraded_total');
    return callOrigin(key);
  }

  // 回源主体：回源前快照世代 -> 真回源 -> 栅栏校验 -> 写缓存。
  // 调用方保证进入这里时锁状态已确定（locked=true 持锁，false 是超时后无锁直连）。
  async function populate(key, tags) {
    // 必须在回源之前取世代快照；回源后用它判断这次结果还能不能写。
    const snapshot = await readGenerations(tags);

    counters.inc('cache_loads_total');
    const result = await loader(key).catch((error) => {
      counters.inc('cache_load_errors_total');
      throw error;
    });
    const found = result.found !== false;
    const value = found ? result.value : null;

    let current;
    try {
      current = await readGenerations(tags);
    } catch (error) {
      // 回源已经成功，只是栅栏读不出来：宁可不写，也不能把好请求搞成 5xx。
      if (isStoreDown(error)) {
        counters.inc('cache_degraded_total');
        return value;
      }
      throw error;
    }
    if (!generationsEqual(snapshot, current)) {
      // 回源途中这个 key 关联的 tag 被失效过，旧结果不许再盖回缓存。
      counters.inc('cache_fenced_writes_total');
      return value;
    }

    const entry = { v: value, neg: !found, gens: snapshot };
    const ttlMs = found
      ? (result.ttlMs ?? config.defaultTtlMs)
      : config.negativeTtlMs;
    try {
      await store.set(ENTRY_PREFIX + key, JSON.stringify(entry), ttlMs);
    } catch (error) {
      // 回源成功但写缓存失败：值照常返回，只计降级。
      if (isStoreDown(error)) {
        counters.inc('cache_degraded_total');
        return value;
      }
      throw error;
    }
    return value;
  }

  // 跨实例防击穿：抢锁、退避重读、超时接手；本实例内并发由 inflight 收敛。
  async function loadWithLock(key, tags) {
    const deadline = now() + config.lockWaitMs;
    const token = String(await store.incr(LOCK_TOKEN_KEY, 1));
    const lockKey = LOCK_PREFIX + key;
    let locked = false;
    try {
      for (;;) {
        if (await store.setIfAbsent(lockKey, token, config.lockTtlMs)) {
          locked = true;
          break;
        }
        await sleep(config.lockRetryMs);

        // 持锁的实例可能已经写好了，重读命中就直接用。
        const cached = await readValidEntry(key);
        if (cached.hit) {
          return cached.value;
        }

        if (now() >= deadline) {
          // 等够了：自己再抢一次；还是抢不到就直接回源，不无限期挂着。
          if (await store.setIfAbsent(lockKey, token, config.lockTtlMs)) {
            locked = true;
            break;
          }
          return populate(key, tags);
        }
      }
      return await populate(key, tags);
    } finally {
      if (locked) {
        // 只删自己那把锁：锁可能早就过期并被别人接手，compareAndDel 防误删。
        // 这里存储挂了也不影响返回值，锁 TTL 到点会自动放。
        try {
          await store.compareAndDel(lockKey, token);
        } catch {
          // 忽略：有 lockTtlMs 兜底。
        }
      }
    }
  }

  // 单飞归属者：包一层统一处理回源前的 StoreDownError 和 inflight 清理。
  function startLoad(key, tags) {
    const job = (async () => {
      try {
        return await loadWithLock(key, tags);
      } catch (error) {
        if (isStoreDown(error)) {
          return originWithoutCache(key);
        }
        throw error;
      }
    })();
    const tracked = job.finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, tracked);
    return tracked;
  }

  return {
    async get(key, options = {}) {
      const tags = options.tags ?? [];
      counters.inc('cache_gets_total');

      let cached;
      try {
        cached = await readValidEntry(key);
      } catch (error) {
        if (isStoreDown(error)) {
          return originWithoutCache(key);
        }
        throw error;
      }

      if (cached.hit) {
        counters.inc('cache_hits_total');
        return cached.value;
      }
      counters.inc('cache_misses_total');

      const pending = inflight.get(key) ?? startLoad(key, tags);
      return pending;
    },
    async invalidateTag(tag) {
      counters.inc('cache_invalidations_total');
      // 原子自增：并发失效、连续失效都只会往上走，绝不读出来加一再写回。
      await store.incr(GEN_PREFIX + tag, 1);
    },
    stats() {
      return { counters: counters.snapshot(), inflight: inflight.size };
    },
  };
}
