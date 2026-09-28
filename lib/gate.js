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

// 判定顺序：租户桶 -> 租户窗口 -> 共享池的桶 -> 共享池的窗口
const TENANT_BUCKET = { reason: 'bucket', label: '租户桶' };
const TENANT_WINDOW = { reason: 'window', label: '租户窗口' };

const round6 = (value) => Math.round(value * 1e6) / 1e6;

const isPositiveNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

function badConfig(message) {
  throw new GateError('ERR_BAD_CONFIG', message);
}

function readBucketConfig(config, where) {
  if (!config || typeof config !== 'object') badConfig(`${where}配置不合法`);
  const { capacity, refillPerSec } = config;
  if (!isPositiveNumber(capacity) || !isPositiveNumber(refillPerSec)) {
    badConfig(`${where}的 capacity / refillPerSec 必须是正数`);
  }
  return { capacity, refillPerSec };
}

function readWindowConfig(config, where) {
  if (!config || typeof config !== 'object') badConfig(`${where}配置不合法`);
  const sizeMs = config.sizeMs === undefined ? DEFAULTS.windowMs : config.sizeMs;
  const { max } = config;
  if (!isPositiveNumber(sizeMs) || !isPositiveNumber(max)) {
    badConfig(`${where}的 sizeMs / max 必须是正数`);
  }
  return { sizeMs, max };
}

function makeBucket(config) {
  return {
    capacity: config.capacity,
    refillPerSec: config.refillPerSec,
    tokens: config.capacity, // 初始满桶
    refillAt: null, // 第一次见到的时间作为补桶起点，之前不补
  };
}

function makeWindow(config) {
  return { sizeMs: config.sizeMs, max: config.max, records: [] };
}

// 按毫秒线性补到 now；时钟回拨时 now 不会倒退，elapsed 最多是 0。
function projectBucket(bucket, now) {
  if (bucket.refillAt === null) {
    bucket.tokens = round6(bucket.tokens);
    bucket.refillAt = now;
    return bucket.tokens;
  }
  const elapsed = now - bucket.refillAt;
  if (elapsed > 0) {
    bucket.tokens = round6(
      Math.min(bucket.capacity, bucket.tokens + (elapsed / 1000) * bucket.refillPerSec),
    );
    bucket.refillAt = now;
  }
  return bucket.tokens;
}

function activeRecords(window, now) {
  // 正好隔了 sizeMs 的记录算滚出去（严格小于）
  window.records = window.records.filter((record) => now - record.at < window.sizeMs);
  return window.records;
}

const sumCost = (records) => records.reduce((total, record) => total + record.cost, 0);

// 窗口试扣：不够就按“最早的记录依次滚出去，直到腾出 need 额度”算等待时间。
function probeWindow(window, now, cost) {
  const records = activeRecords(window, now);
  const used = sumCost(records);
  const need = used + cost - window.max;
  if (need <= 0) return { used, wait: 0, pass: true };
  let freed = 0;
  for (const record of [...records].sort((a, b) => a.at - b.at)) {
    freed += record.cost;
    if (freed >= need) {
      return { used, wait: Math.max(0, Math.ceil(record.at + window.sizeMs - now)), pass: false };
    }
  }
  return { used, wait: null, pass: false }; // cost > max，等多久都没用
}

function bucketWait(bucket, tokens, cost) {
  return Math.ceil(((cost - tokens) / bucket.refillPerSec) * 1000);
}

export function createGate(options = {}) {
  const clock = options.clock ?? createSystemClock();
  const world = { tenants: new Map(), groups: new Map() };
  let lastSeen = null;
  const counters = {
    allowed: 0,
    denied: 0,
    byReason: { bucket: 0, window: 0, shared: 0 },
  };

  if (options.groups !== undefined) {
    if (!Array.isArray(options.groups)) badConfig('groups 必须是数组');
    for (const groupOptions of options.groups) {
      if (
        !groupOptions ||
        typeof groupOptions !== 'object' ||
        typeof groupOptions.name !== 'string' ||
        groupOptions.name.trim() === ''
      ) {
        badConfig('共享池名字不合法');
      }
      if (world.groups.has(groupOptions.name)) {
        badConfig(`共享池 ${groupOptions.name} 重名`);
      }
      const bucket = groupOptions.bucket
        ? makeBucket(readBucketConfig(groupOptions.bucket, `共享池 ${groupOptions.name}`))
        : null;
      const window = groupOptions.window
        ? makeWindow(readWindowConfig(groupOptions.window, `共享池 ${groupOptions.name}`))
        : null;
      if (!bucket && !window) badConfig(`共享池 ${groupOptions.name} 一道上限都没配`);
      world.groups.set(groupOptions.name, { name: groupOptions.name, bucket, window });
    }
  }

  // 时钟回拨时按上一次见过的时间算：raw 变小就粘在 lastSeen 上，既不补桶也不清窗口。
  function tick() {
    const raw = clock.now();
    const now = lastSeen === null || raw > lastSeen ? raw : lastSeen;
    lastSeen = now;
    return now;
  }

  function getTenant(tenant) {
    const state = world.tenants.get(tenant);
    if (!state) {
      throw new GateError('ERR_UNKNOWN_TENANT', `租户 ${tenant} 没配过`, { tenant });
    }
    return state;
  }

  function costLimits(tenantState, groupState) {
    const limits = [];
    if (tenantState.bucket) limits.push(tenantState.bucket.capacity);
    if (tenantState.window) limits.push(tenantState.window.max);
    if (groupState?.bucket) limits.push(groupState.bucket.capacity);
    if (groupState?.window) limits.push(groupState.window.max);
    return limits;
  }

  function validateCost(tenantState, groupState, cost) {
    if (!Number.isInteger(cost) || cost <= 0) {
      throw new GateError('ERR_COST_TOO_LARGE', 'cost 必须是正整数', { cost });
    }
    for (const limit of costLimits(tenantState, groupState)) {
      if (cost > limit) {
        throw new GateError('ERR_COST_TOO_LARGE', `cost ${cost} 超过上限 ${limit}`, {
          cost,
          limit,
        });
      }
    }
  }

  // 在给定世界（正式状态或批量判定的影子世界）上判一笔；过了才在这个世界里真扣。
  function evaluate(targetWorld, tenantName, cost, now) {
    const tenantState = targetWorld.tenants.get(tenantName);
    const groupState = tenantState.shared ? targetWorld.groups.get(tenantState.shared) : null;
    const failures = [];

    const bucketTokens = tenantState.bucket ? projectBucket(tenantState.bucket, now) : null;
    if (tenantState.bucket && bucketTokens < cost) {
      failures.push({ ...TENANT_BUCKET, wait: bucketWait(tenantState.bucket, bucketTokens, cost) });
    }

    let windowProbe = null;
    if (tenantState.window) {
      windowProbe = probeWindow(tenantState.window, now, cost);
      if (!windowProbe.pass) failures.push({ ...TENANT_WINDOW, wait: windowProbe.wait });
    }

    let sharedTokens = null;
    let sharedProbe = null;
    if (groupState) {
      if (groupState.bucket) {
        sharedTokens = projectBucket(groupState.bucket, now);
        if (sharedTokens < cost) {
          failures.push({
            reason: 'shared',
            label: `共享池 ${groupState.name} 的桶`,
            wait: bucketWait(groupState.bucket, sharedTokens, cost),
          });
        }
      }
      if (groupState.window) {
        sharedProbe = probeWindow(groupState.window, now, cost);
        if (!sharedProbe.pass) {
          failures.push({
            reason: 'shared',
            label: `共享池 ${groupState.name} 的窗口`,
            wait: sharedProbe.wait,
          });
        }
      }
    }

    const allowed = failures.length === 0;
    if (allowed) {
      if (tenantState.bucket) tenantState.bucket.tokens = round6(bucketTokens - cost);
      if (tenantState.window) tenantState.window.records.push({ at: now, cost });
      if (groupState?.bucket) groupState.bucket.tokens = round6(sharedTokens - cost);
      if (groupState?.window) groupState.window.records.push({ at: now, cost });
    }

    const remaining = {
      bucketTokens: null,
      windowRemaining: null,
      sharedRemaining: null,
    };
    if (tenantState.bucket) {
      remaining.bucketTokens = allowed ? round6(bucketTokens - cost) : bucketTokens;
    }
    if (tenantState.window) {
      remaining.windowRemaining = Math.max(0, tenantState.window.max - windowProbe.used - cost);
    }
    if (groupState?.bucket) {
      remaining.sharedRemaining = allowed ? round6(sharedTokens - cost) : sharedTokens;
    } else if (groupState?.window) {
      remaining.sharedRemaining = Math.max(0, groupState.window.max - sharedProbe.used - cost);
    }

    const waits = failures.map((failure) => failure.wait);
    return {
      allowed,
      tenant: tenantName,
      cost,
      at: now,
      reason: allowed ? 'ok' : failures[0].reason,
      blockedBy: failures.map((failure) => failure.label),
      retryAfterMs: allowed
        ? 0
        : waits.some((wait) => wait === null)
          ? null
          : Math.min(...waits),
      remaining,
    };
  }

  function check(tenant, cost = 1) {
    const tenantState = getTenant(tenant);
    const groupState = tenantState.shared ? world.groups.get(tenantState.shared) : null;
    validateCost(tenantState, groupState, cost);
    const now = tick();
    const result = evaluate(world, tenant, cost, now);
    if (result.allowed) {
      counters.allowed += 1;
    } else {
      counters.denied += 1;
      counters.byReason[result.reason] += 1;
    }
    return result;
  }

  function checkMany(requests) {
    if (!Array.isArray(requests) || requests.length === 0) {
      badConfig('checkMany 必须传非空数组');
    }
    // 先把整批入参全部验完再判定，避免抛错时留下半截状态。
    for (const request of requests) {
      if (!request || typeof request.tenant !== 'string') badConfig('checkMany 每项要有 tenant');
      const tenantState = getTenant(request.tenant);
      const groupState = tenantState.shared ? world.groups.get(tenantState.shared) : null;
      validateCost(tenantState, groupState, request.cost ?? 1);
    }
    const now = tick();
    // 影子世界上顺序判定、逐个累加；全过才整体提交，有一笔不过就整体回滚。
    const shadow = {
      tenants: structuredClone(world.tenants),
      groups: structuredClone(world.groups),
    };
    const results = requests.map((request) =>
      evaluate(shadow, request.tenant, request.cost ?? 1, now),
    );
    const allowed = results.every((result) => result.allowed);
    if (allowed) {
      world.tenants = shadow.tenants;
      world.groups = shadow.groups;
      counters.allowed += results.length;
    }
    return { allowed, results };
  }

  function tenantStats(tenantState, now) {
    return {
      tenant: tenantState.tenant,
      shared: tenantState.shared,
      bucket: tenantState.bucket
        ? { tokens: projectBucket(tenantState.bucket, now), capacity: tenantState.bucket.capacity }
        : null,
      window: tenantState.window
        ? {
            sizeMs: tenantState.window.sizeMs,
            max: tenantState.window.max,
            used: sumCost(activeRecords(tenantState.window, now)),
          }
        : null,
    };
  }

  function stats(tenant) {
    const now = tick();
    if (tenant !== undefined) {
      return { tenant: tenantStats(getTenant(tenant), now) };
    }
    const perTenant = {};
    for (const [name, tenantState] of world.tenants) {
      perTenant[name] = tenantStats(tenantState, now);
    }
    return {
      allowed: counters.allowed,
      denied: counters.denied,
      byReason: { ...counters.byReason },
      tenants: world.tenants.size,
      groups: world.groups.size,
      perTenant,
    };
  }

  function register(config = {}) {
    if (typeof config.tenant !== 'string' || config.tenant.trim() === '') {
      badConfig('tenant 必须是非空字符串');
    }
    if (world.tenants.has(config.tenant)) badConfig(`租户 ${config.tenant} 已经注册过`);
    let shared = null;
    if (config.shared !== undefined) {
      if (typeof config.shared !== 'string' || !world.groups.has(config.shared)) {
        badConfig(`共享池 ${config.shared} 没配过`);
      }
      shared = config.shared;
    }
    const bucket =
      config.bucket !== undefined
        ? makeBucket(readBucketConfig(config.bucket, '租户桶'))
        : null;
    const window =
      config.window !== undefined
        ? makeWindow(readWindowConfig(config.window, '租户窗口'))
        : null;
    if (!bucket && !window) badConfig(`租户 ${config.tenant} 一道上限都没配`);
    world.tenants.set(config.tenant, { tenant: config.tenant, shared, bucket, window });
    return {
      tenant: config.tenant,
      shared,
      limits: { bucket: Boolean(bucket), window: Boolean(window) },
    };
  }

  function snapshot() {
    const raw = clock.now();
    const now = lastSeen === null || raw > lastSeen ? raw : lastSeen;
    const serializeTenant = (tenantState) => ({
      tenant: tenantState.tenant,
      shared: tenantState.shared,
      bucket: tenantState.bucket ? structuredClone(tenantState.bucket) : null,
      window: tenantState.window
        ? {
            sizeMs: tenantState.window.sizeMs,
            max: tenantState.window.max,
            records: activeRecords(tenantState.window, now).map((record) => ({ ...record })),
          }
        : null,
    });
    const serializeGroup = (groupState) => ({
      name: groupState.name,
      bucket: groupState.bucket ? structuredClone(groupState.bucket) : null,
      window: groupState.window
        ? {
            sizeMs: groupState.window.sizeMs,
            max: groupState.window.max,
            records: activeRecords(groupState.window, now).map((record) => ({ ...record })),
          }
        : null,
    });
    return {
      version: SNAPSHOT_VERSION,
      lastSeen: now,
      counters: structuredClone(counters),
      tenants: [...world.tenants.values()].map(serializeTenant),
      groups: [...world.groups.values()].map(serializeGroup),
    };
  }

  function restore(state) {
    if (!state || state.version !== SNAPSHOT_VERSION) {
      throw new GateError('ERR_BAD_SNAPSHOT', '快照版本不认识', {
        version: state?.version ?? null,
      });
    }
    lastSeen = state.lastSeen ?? null;
    counters.allowed = state.counters?.allowed ?? 0;
    counters.denied = state.counters?.denied ?? 0;
    counters.byReason = { bucket: 0, window: 0, shared: 0, ...(state.counters?.byReason ?? {}) };
    world.tenants = new Map(
      (state.tenants ?? []).map((tenantState) => [tenantState.tenant, structuredClone(tenantState)]),
    );
    world.groups = new Map(
      (state.groups ?? []).map((groupState) => [groupState.name, structuredClone(groupState)]),
    );
    return { tenants: world.tenants.size, groups: world.groups.size };
  }

  return { register, check, checkMany, stats, snapshot, restore };
}
