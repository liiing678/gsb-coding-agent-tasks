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

// 共享存储里的 key（前缀是定死的，见 README）：
//   cache:<key>       缓存条目，JSON：{ v, neg, g: { <tag>: 世代号或 null } }
//   cache:gen:<tag>   tag 的世代号，只用 incr 往上推
//   cache:lock:<key>  回源锁，值是持锁者的 token
//   cache:lockseq     锁 token 的全局序号（incr 发号，跨实例不会撞）
const LOCK_SEQ_KEY = 'cache:lockseq';

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

  const entryKey = (key) => `cache:${key}`;
  const genKey = (tag) => `cache:gen:${tag}`;
  const lockKey = (key) => `cache:lock:${key}`;

  // 本实例正在回源的 key -> promise；同实例并发的等待者挂到同一个 promise 上
  const inflights = new Map();

  async function readGens(tags) {
    const gens = {};
    for (const tag of tags) {
      const raw = await store.get(genKey(tag));
      gens[tag] = raw === null ? null : Number(raw);
    }
    return gens;
  }

  // 读条目并校验 tag 世代。命中返回 { value }，不存在/世代对不上返回 null。
  async function readEntry(key) {
    const raw = await store.get(entryKey(key));
    if (raw === null) return null;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      return null;
    }
    const gens = entry.g ?? {};
    for (const tag of Object.keys(gens)) {
      const rawGen = await store.get(genKey(tag));
      const current = rawGen === null ? null : Number(rawGen);
      if (current !== gens[tag]) return null;
    }
    return { value: entry.neg ? null : entry.v };
  }

  async function nextLockToken() {
    return String(await store.incr(LOCK_SEQ_KEY));
  }

  async function releaseLock(key, token) {
    try {
      // 带自己的 token 删：锁已经过期被别人接手的话，绝不能把人家的锁删掉
      await store.compareAndDel(lockKey(key), token);
    } catch (err) {
      // 共享存储抖了就让锁自己过期，别盖住回源的结果/错误
      if (!(err instanceof StoreDownError)) throw err;
    }
  }

  // 真回源一次。回源前取 tag 世代快照；回来后世代变了就不许写回（失效栅栏）。
  async function loadAndMaybeWrite(key, tags) {
    counters.inc('cache_loads_total');
    const snapshot = await readGens(tags);
    let result;
    try {
      result = await loader(key);
    } catch (err) {
      counters.inc('cache_load_errors_total');
      throw err;
    }
    try {
      const current = await readGens(tags);
      const fenced = tags.some((tag) => current[tag] !== snapshot[tag]);
      if (fenced) {
        counters.inc('cache_fenced_writes_total');
      } else {
        const entry = result.found
          ? { v: result.value, neg: false, g: snapshot }
          : { v: null, neg: true, g: snapshot };
        const ttlMs = result.found
          ? (result.ttlMs ?? config.defaultTtlMs)
          : config.negativeTtlMs;
        await store.set(entryKey(key), JSON.stringify(entry), ttlMs);
      }
    } catch (err) {
      // 回源已经成功，只是写缓存这步失败：照常把值返回，记一笔降级
      if (!(err instanceof StoreDownError)) throw err;
      counters.inc('cache_degraded_total');
    }
    return result.found ? result.value : null;
  }

  async function loadWithLock(key, tags, token) {
    try {
      return await loadAndMaybeWrite(key, tags);
    } finally {
      await releaseLock(key, token);
    }
  }

  // 未命中之后的处理：先抢锁，抢不到就退避重读缓存；等超时了自己抢一次，
  // 还抢不到就直接回源，不能把请求无限期挂在那儿。
  async function resolveMiss(key, tags) {
    const token = await nextLockToken();
    if (await store.setIfAbsent(lockKey(key), token, config.lockTtlMs)) {
      return await loadWithLock(key, tags, token);
    }
    const deadline = now() + config.lockWaitMs;
    while (now() < deadline) {
      await sleep(config.lockRetryMs);
      const entry = await readEntry(key);
      if (entry) return entry.value;
      const retryToken = await nextLockToken();
      if (await store.setIfAbsent(lockKey(key), retryToken, config.lockTtlMs)) {
        return await loadWithLock(key, tags, retryToken);
      }
    }
    const lastToken = await nextLockToken();
    if (await store.setIfAbsent(lockKey(key), lastToken, config.lockTtlMs)) {
      return await loadWithLock(key, tags, lastToken);
    }
    return await loadAndMaybeWrite(key, tags);
  }

  // 共享存储不可用时的降级直连：不写缓存
  async function degradedLoad(key) {
    counters.inc('cache_loads_total');
    let result;
    try {
      result = await loader(key);
    } catch (err) {
      counters.inc('cache_load_errors_total');
      throw err;
    }
    return result.found ? result.value : null;
  }

  async function get(key, options = {}) {
    counters.inc('cache_gets_total');
    const tags = Array.isArray(options.tags) ? options.tags : [];
    try {
      const entry = await readEntry(key);
      if (entry) {
        counters.inc('cache_hits_total');
        return entry.value;
      }
      counters.inc('cache_misses_total');
      let inflight = inflights.get(key);
      if (!inflight) {
        // 检查到写入之间不能有 await，同实例的并发只会有一条真的去回源
        const promise = resolveMiss(key, tags);
        inflight = promise.then(
          (value) => {
            inflights.delete(key);
            return value;
          },
          (err) => {
            inflights.delete(key);
            throw err;
          },
        );
        inflights.set(key, inflight);
      }
      return await inflight;
    } catch (err) {
      // 只有共享存储的错才走降级；回源自己抛的错照常往上抛
      if (!(err instanceof StoreDownError)) throw err;
      counters.inc('cache_degraded_total');
      if (config.failMode === 'fail_fast') {
        throw new CacheUnavailableError();
      }
      return await degradedLoad(key);
    }
  }

  async function invalidateTag(tag) {
    counters.inc('cache_invalidations_total');
    try {
      // 原子自增：并发失效、连续失效都只会往上走，不会回退
      await store.incr(genKey(tag));
    } catch (err) {
      if (!(err instanceof StoreDownError)) throw err;
      counters.inc('cache_degraded_total');
      if (config.failMode === 'fail_fast') {
        throw new CacheUnavailableError();
      }
    }
  }

  function stats() {
    return { counters: counters.snapshot(), inflight: inflights.size };
  }

  return {
    get,
    invalidateTag,
    stats,
  };
}
