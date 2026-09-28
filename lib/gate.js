// 多租户限流与配额。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/bucket|window|gate）、演示脚本
// （scripts/demo.mjs）、时钟（lib/clock.js）和错误码（lib/errors.js）都已经按
// README 的《口径》和《API》两节写好了。那些约定不要改，把这里补出来。

import { createSystemClock } from './clock.js';
import { GateError } from './errors.js';

export const DEFAULTS = {
  windowMs: 1000, // window.sizeMs 不给的时候用这个
};

const SNAPSHOT_VERSION = 1;

// 令牌保留 6 位小数，免得浮点尾巴让判定飘。
const round6 = (value) => Math.round(value * 1e6) / 1e6;

function badConfig(message, details = {}) {
  throw new GateError('ERR_BAD_CONFIG', message, details);
}

function parseBucket(cfg) {
  if (cfg == null) return null;
  const ok =
    typeof cfg === 'object' &&
    Number.isInteger(cfg.capacity) &&
    cfg.capacity > 0 &&
    Number.isFinite(cfg.refillPerSec) &&
    cfg.refillPerSec > 0;
  if (!ok) badConfig('bucket 配置不合法：capacity 要是正整数，refillPerSec 要是正数');
  return { capacity: cfg.capacity, refillPerSec: cfg.refillPerSec, tokens: cfg.capacity, lastRefill: 0 };
}

function parseWindow(cfg) {
  if (cfg == null) return null;
  const sizeMs = typeof cfg === 'object' && cfg.sizeMs != null ? cfg.sizeMs : DEFAULTS.windowMs;
  const ok =
    typeof cfg === 'object' &&
    Number.isInteger(sizeMs) &&
    sizeMs > 0 &&
    Number.isInteger(cfg.max) &&
    cfg.max > 0;
  if (!ok) badConfig('window 配置不合法：sizeMs 和 max 都要是正整数');
  return { sizeMs, max: cfg.max, records: [] };
}

// 按毫秒线性补，补到容量为止；时钟回拨时 now 不会倒退，elapsed<=0 就什么都不补。
function refillBucket(bucket, now) {
  if (!bucket) return;
  const elapsed = now - bucket.lastRefill;
  if (elapsed <= 0) return;
  bucket.tokens = round6(Math.min(bucket.capacity, bucket.tokens + (elapsed / 1000) * bucket.refillPerSec));
  bucket.lastRefill = now;
}

// 精确滑动：每条记录自己过期，正好隔了 sizeMs 的那条算滚出去了。
function pruneWindow(win, now) {
  win.records = win.records.filter((rec) => now - rec.at < win.sizeMs);
  return win.records;
}

function windowUsed(win, now) {
  return pruneWindow(win, now).reduce((sum, rec) => sum + rec.cost, 0);
}

// 缺多少令牌就等多久：ceil(缺额 / refillPerSec * 1000)。
function bucketWait(bucket, cost) {
  const need = round6(cost - bucket.tokens);
  if (need <= 0) return 0;
  return Math.ceil(round6((need / bucket.refillPerSec) * 1000));
}

// 从最早那条开始滚，滚出去的额度凑够缺口为止。
function windowWait(win, cost, now, used) {
  const need = used + cost - win.max;
  if (need <= 0) return 0;
  let freed = 0;
  for (const rec of win.records) {
    freed += rec.cost;
    if (freed >= need) return rec.at + win.sizeMs - now;
  }
  return null; // 怎么等都过不了
}

function serializeBucket(bucket) {
  return bucket
    ? { capacity: bucket.capacity, refillPerSec: bucket.refillPerSec, tokens: bucket.tokens, lastRefill: bucket.lastRefill }
    : null;
}

function serializeWindow(win) {
  return win ? { sizeMs: win.sizeMs, max: win.max, records: win.records.map((rec) => ({ ...rec })) } : null;
}

function deserializeBucket(bucket) {
  return bucket
    ? {
        capacity: bucket.capacity,
        refillPerSec: bucket.refillPerSec,
        tokens: bucket.tokens,
        lastRefill: Number.isFinite(bucket.lastRefill) ? bucket.lastRefill : 0,
      }
    : null;
}

function deserializeWindow(win) {
  return win
    ? { sizeMs: win.sizeMs, max: win.max, records: (win.records ?? []).map((rec) => ({ at: rec.at, cost: rec.cost })) }
    : null;
}

export function createGate(options = {}) {
  const clock = options.clock ?? createSystemClock();
  if (typeof clock.now !== 'function') badConfig('clock 需要提供 now()');

  const tenants = new Map();
  const groups = new Map();
  const counters = { allowed: 0, denied: 0, byReason: { bucket: 0, window: 0, shared: 0 } };
  let lastSeen = 0;

  const groupConfigs = options.groups ?? [];
  if (!Array.isArray(groupConfigs)) badConfig('groups 必须是数组');
  for (const cfg of groupConfigs) {
    if (!cfg || typeof cfg.name !== 'string' || cfg.name.length === 0) badConfig('共享池要有名字');
    if (groups.has(cfg.name)) badConfig(`共享池 ${cfg.name} 配了两次`, { group: cfg.name });
    const bucket = parseBucket(cfg.bucket);
    const window = parseWindow(cfg.window);
    if (!bucket && !window) badConfig(`共享池 ${cfg.name} 至少要有一道上限`, { group: cfg.name });
    groups.set(cfg.name, { name: cfg.name, bucket, window });
  }

  // 时钟回拨不白给额度：永远按见过的最大时间算。
  function tick() {
    const raw = clock.now();
    if (raw > lastSeen) lastSeen = raw;
    return lastSeen;
  }

  function getTenant(name) {
    const entry = tenants.get(name);
    if (!entry) throw new GateError('ERR_UNKNOWN_TENANT', `未知租户: ${name}`, { tenant: name });
    return entry;
  }

  function getGroup(entry) {
    return entry.shared ? groups.get(entry.shared) : null;
  }

  // cost 必须是正整数，而且不能超过任何一道配好的上限（等多久都没用的那种）。
  function assertCost(entry, cost) {
    if (!Number.isInteger(cost) || cost <= 0) {
      throw new GateError('ERR_COST_TOO_LARGE', `cost 要是正整数，收到 ${cost}`, { cost });
    }
    const group = getGroup(entry);
    const limits = [];
    if (entry.bucket) limits.push(entry.bucket.capacity);
    if (entry.window) limits.push(entry.window.max);
    if (group?.bucket) limits.push(group.bucket.capacity);
    if (group?.window) limits.push(group.window.max);
    for (const limit of limits) {
      if (cost > limit) {
        throw new GateError('ERR_COST_TOO_LARGE', `cost ${cost} 超过上限 ${limit}`, { cost, limit });
      }
    }
  }

  // 判定顺序固定：租户桶 → 租户窗口 → 共享池的桶 → 共享池的窗口。
  // 判定和扣额度分开：任何一道不过，谁都别扣。
  function adjudicate(entry, cost, now) {
    const group = getGroup(entry);
    refillBucket(entry.bucket, now);
    if (group) refillBucket(group.bucket, now);

    const failures = [];
    let bucketTokens = null;
    let windowRemaining = null;
    let sharedRemaining = null;

    if (entry.bucket) {
      const bucket = entry.bucket;
      const pass = bucket.tokens >= cost;
      bucketTokens = pass ? round6(bucket.tokens - cost) : bucket.tokens;
      if (!pass) failures.push({ reason: 'bucket', label: '租户桶', wait: bucketWait(bucket, cost) });
    }

    if (entry.window) {
      const win = entry.window;
      const used = windowUsed(win, now);
      const pass = used + cost <= win.max;
      windowRemaining = pass ? win.max - used - cost : win.max - used;
      if (!pass) failures.push({ reason: 'window', label: '租户窗口', wait: windowWait(win, cost, now, used) });
    }

    if (group?.bucket) {
      const bucket = group.bucket;
      const pass = bucket.tokens >= cost;
      sharedRemaining = pass ? round6(bucket.tokens - cost) : bucket.tokens;
      if (!pass) failures.push({ reason: 'shared', label: `共享池 ${group.name} 的桶`, wait: bucketWait(bucket, cost) });
    }

    if (group?.window) {
      const win = group.window;
      const used = windowUsed(win, now);
      const pass = used + cost <= win.max;
      const remaining = pass ? win.max - used - cost : win.max - used;
      sharedRemaining = sharedRemaining == null ? remaining : Math.min(sharedRemaining, remaining);
      if (!pass) failures.push({ reason: 'shared', label: `共享池 ${group.name} 的窗口`, wait: windowWait(win, cost, now, used) });
    }

    const allowed = failures.length === 0;
    const reason = allowed ? 'ok' : failures[0].reason;
    let retryAfterMs = 0;
    if (!allowed) {
      retryAfterMs = failures.some((failure) => failure.wait === null)
        ? null
        : Math.min(...failures.map((failure) => failure.wait));
    }

    if (allowed) {
      if (entry.bucket) entry.bucket.tokens = round6(entry.bucket.tokens - cost);
      if (entry.window) entry.window.records.push({ at: now, cost });
      if (group?.bucket) group.bucket.tokens = round6(group.bucket.tokens - cost);
      if (group?.window) group.window.records.push({ at: now, cost });
      counters.allowed += 1;
    } else {
      counters.denied += 1;
      counters.byReason[reason] += 1;
    }

    return {
      allowed,
      tenant: entry.tenant,
      cost,
      at: now,
      reason,
      blockedBy: failures.map((failure) => failure.label),
      retryAfterMs,
      remaining: { bucketTokens, windowRemaining, sharedRemaining },
    };
  }

  function register(cfg = {}) {
    const tenant = cfg.tenant;
    if (typeof tenant !== 'string' || tenant.length === 0) badConfig('租户名要是非空字符串');
    if (tenants.has(tenant)) badConfig(`租户 ${tenant} 已经注册过了`, { tenant });
    const bucket = parseBucket(cfg.bucket);
    const window = parseWindow(cfg.window);
    let shared = null;
    if (cfg.shared != null) {
      if (typeof cfg.shared !== 'string' || !groups.has(cfg.shared)) {
        badConfig(`共享池没配过: ${cfg.shared}`, { shared: cfg.shared });
      }
      shared = cfg.shared;
    }
    if (!bucket && !window && !shared) badConfig('租户至少要有一道上限', { tenant });
    tenants.set(tenant, { tenant, shared, bucket, window });
    return { tenant, shared, limits: { bucket: !!bucket, window: !!window } };
  }

  function check(tenant, cost = 1) {
    const now = tick();
    const entry = getTenant(tenant);
    assertCost(entry, cost);
    return adjudicate(entry, cost, now);
  }

  // 同一时刻的一批：顺序判定、逐个累加；只要有一笔不过就整批回滚。
  function checkMany(items) {
    if (!Array.isArray(items) || items.length === 0) badConfig('checkMany 需要非空数组');
    const backup = snapshot();
    const now = tick();
    const results = [];
    try {
      for (const item of items) {
        const entry = getTenant(item?.tenant);
        const cost = item?.cost ?? 1;
        assertCost(entry, cost);
        results.push(adjudicate(entry, cost, now));
      }
    } catch (err) {
      restore(backup);
      throw err;
    }
    const allowed = results.every((result) => result.allowed);
    if (!allowed) restore(backup);
    return { allowed, results };
  }

  function tenantView(entry, now) {
    refillBucket(entry.bucket, now);
    return {
      tenant: entry.tenant,
      shared: entry.shared,
      bucket: entry.bucket ? { tokens: entry.bucket.tokens, capacity: entry.bucket.capacity } : null,
      window: entry.window
        ? { sizeMs: entry.window.sizeMs, max: entry.window.max, used: windowUsed(entry.window, now) }
        : null,
    };
  }

  function stats(name) {
    const now = tick();
    const base = {
      allowed: counters.allowed,
      denied: counters.denied,
      byReason: { ...counters.byReason },
      tenants: tenants.size,
      groups: groups.size,
      perTenant: {},
    };
    for (const entry of tenants.values()) base.perTenant[entry.tenant] = tenantView(entry, now);
    if (name === undefined) return base;
    return { ...base, tenant: tenantView(getTenant(name), now) };
  }

  function snapshot() {
    return {
      version: SNAPSHOT_VERSION,
      lastSeen,
      counters: {
        allowed: counters.allowed,
        denied: counters.denied,
        byReason: { ...counters.byReason },
      },
      tenants: [...tenants.values()].map((entry) => ({
        tenant: entry.tenant,
        shared: entry.shared,
        bucket: serializeBucket(entry.bucket),
        window: serializeWindow(entry.window),
      })),
      groups: [...groups.values()].map((group) => ({
        name: group.name,
        bucket: serializeBucket(group.bucket),
        window: serializeWindow(group.window),
      })),
    };
  }

  function restore(state) {
    if (!state || typeof state !== 'object' || state.version !== SNAPSHOT_VERSION) {
      throw new GateError('ERR_BAD_SNAPSHOT', '快照版本不认识', { version: state?.version });
    }
    tenants.clear();
    groups.clear();
    for (const group of state.groups ?? []) {
      groups.set(group.name, {
        name: group.name,
        bucket: deserializeBucket(group.bucket),
        window: deserializeWindow(group.window),
      });
    }
    for (const entry of state.tenants ?? []) {
      tenants.set(entry.tenant, {
        tenant: entry.tenant,
        shared: entry.shared ?? null,
        bucket: deserializeBucket(entry.bucket),
        window: deserializeWindow(entry.window),
      });
    }
    counters.allowed = state.counters?.allowed ?? 0;
    counters.denied = state.counters?.denied ?? 0;
    counters.byReason = { bucket: 0, window: 0, shared: 0, ...state.counters?.byReason };
    lastSeen = Number.isFinite(state.lastSeen) ? state.lastSeen : 0;
    return { tenants: tenants.size, groups: groups.size };
  }

  return { register, check, checkMany, stats, snapshot, restore };
}
