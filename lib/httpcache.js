// HTTP 缓存语义层。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/freshness.test.js、test/revalidate.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import { HttpCacheError } from './errors.js';

export const DEFAULTS = {
  maxEntries: 100,
  heuristicFraction: 0.1,
};

const CACHEABLE_STATUS = new Set([200, 203, 204, 300, 301, 308, 404, 405, 410, 414, 501]);
const INTEGER_RE = /^\d+$/;

const isObject = (value) => value !== null && typeof value === 'object';

const bad = (code, message) => {
  throw new HttpCacheError(code, message);
};

// 头名统一折成小写；值必须是字符串。
function normalizeHeaders(headers, code) {
  if (!isObject(headers)) bad(code, 'headers 必须是对象');
  const out = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') bad(code, `头 ${name} 的值必须是字符串`);
    out[name.toLowerCase()] = value;
  }
  return out;
}

function validateRequest(request) {
  if (!isObject(request)) bad('ERR_BAD_REQUEST', 'request 必须是对象');
  const { method, url } = request;
  if (typeof method !== 'string' || method.length === 0) {
    bad('ERR_BAD_REQUEST', 'method 必须是非空字符串');
  }
  if (typeof url !== 'string' || url.length === 0) {
    bad('ERR_BAD_REQUEST', 'url 必须是非空字符串');
  }
  return { method, url, headers: normalizeHeaders(request.headers, 'ERR_BAD_REQUEST') };
}

function validateResponse(response) {
  if (!isObject(response)) bad('ERR_BAD_RESPONSE', 'response 必须是对象');
  const { status } = response;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    bad('ERR_BAD_RESPONSE', 'status 必须是 100..599 的整数');
  }
  return { status, headers: normalizeHeaders(response.headers, 'ERR_BAD_RESPONSE') };
}

// Cache-Control：逗号切开，名字小写，值去两侧空白与引号。
function parseCacheControl(value) {
  const directives = Object.create(null);
  if (!value) return directives;
  for (const part of value.split(',')) {
    const equal = part.indexOf('=');
    let name;
    let raw;
    if (equal === -1) {
      name = part.trim();
    } else {
      name = part.slice(0, equal).trim();
      raw = part.slice(equal + 1).trim();
    }
    if (name.length === 0) continue;
    name = name.toLowerCase();
    if (raw === undefined) {
      directives[name] = true;
      continue;
    }
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      raw = raw.slice(1, -1);
    }
    directives[name] = raw;
  }
  return directives;
}

const hasDirective = (directives, name) => Object.prototype.hasOwnProperty.call(directives, name);

// 要数字的指令：不是十进制整数就当没写。
function integerDirective(directives, name) {
  const value = directives[name];
  if (typeof value !== 'string' || !INTEGER_RE.test(value)) return null;
  return Number(value);
}

function integerHeader(headers, name) {
  const value = headers[name];
  if (typeof value !== 'string' || !INTEGER_RE.test(value.trim())) return null;
  return Number(value.trim());
}

function parseVary(headers) {
  const value = headers.vary;
  if (typeof value !== 'string') return [];
  return value.split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

const httpDate = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};


export function createHttpCache(config = {}) {
  if (!isObject(config)) bad('ERR_BAD_CONFIG', 'config 必须是对象');
  const options = { ...DEFAULTS, ...config };
  const { maxEntries, heuristicFraction } = options;
  const clock = options.clock ?? Date.now;
  if (typeof clock !== 'function') bad('ERR_BAD_CONFIG', 'clock 必须是函数');
  if (!Number.isFinite(clock())) bad('ERR_BAD_CONFIG', 'clock 必须返回有限数');
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    bad('ERR_BAD_CONFIG', 'maxEntries 必须是正整数');
  }
  if (typeof heuristicFraction !== 'number' || !Number.isFinite(heuristicFraction)
      || heuristicFraction < 0 || heuristicFraction > 1) {
    bad('ERR_BAD_CONFIG', 'heuristicFraction 必须在 [0, 1] 内');
  }

  // baseKey("<方法> <url>") -> 变体数组；同一条 URL 的不同 Vary 变体各占一个条目。
  const groups = new Map();
  let entryCount = 0;
  const counters = { stores: 0, hits: 0, misses: 0, revalidations: 0, evictions: 0, staleServed: 0 };

  const baseKey = (method, url) => `${method} ${url}`;

  function removeEntry(group, entry) {
    const index = group.indexOf(entry);
    if (index !== -1) group.splice(index, 1);
    entryCount -= 1;
    if (group.length === 0) {
      for (const [key, value] of groups) {
        if (value === group) groups.delete(key);
      }
    }
  }

  // 超过上限按最近使用时间踢最久没用的。
  function evictIfNeeded() {
    while (entryCount > maxEntries) {
      let oldest = null;
      for (const group of groups.values()) {
        for (const entry of group) {
          if (oldest === null || entry.lastUsed < oldest.lastUsed) oldest = entry;
        }
      }
      if (oldest === null) break;
      removeEntry(groups.get(oldest.baseKey), oldest);
      counters.evictions += 1;
    }
  }

  function computeFreshness(headers, cc, storedAt) {
    const sMaxAge = integerDirective(cc, 's-maxage');
    if (sMaxAge !== null) return sMaxAge * 1000;
    const maxAge = integerDirective(cc, 'max-age');
    if (maxAge !== null) return maxAge * 1000;
    const expires = httpDate(headers.expires);
    if (expires !== null) {
      const date = httpDate(headers.date) ?? storedAt;
      return expires - date;
    }
    const date = httpDate(headers.date);
    const lastModified = httpDate(headers['last-modified']);
    if (date !== null && lastModified !== null && date > lastModified) {
      return Math.floor((date - lastModified) * heuristicFraction);
    }
    return 0;
  }

  function makeEntry(res, req, cc, varyNames, storedAt) {
    return {
      baseKey: baseKey(req.method, req.url),
      status: res.status,
      headers: res.headers,
      cc,
      varyNames,
      varyValues: varyNames.map((name) => req.headers[name] ?? null),
      storedAt,
      lastUsed: storedAt,
      freshnessMs: computeFreshness(res.headers, cc, storedAt),
    };
  }

  function matchEntry(group, headers) {
    return group.find((entry) => entry.varyNames.every((name, index) =>
      (headers[name] ?? null) === entry.varyValues[index])) ?? null;
  }

  const miss = () => ({
    hit: false,
    status: 'miss',
    entry: null,
    ageMs: null,
    freshnessMs: null,
    canServeStale: false,
    requiresRevalidation: true,
  });

  // store 规则检查：不过就返回 reason，过了就落条目。
  function admit(req, res, countingStore) {
    const ccRequest = parseCacheControl(req.headers['cache-control']);
    const ccResponse = parseCacheControl(res.headers['cache-control']);
    if (req.method !== 'GET' && req.method !== 'HEAD') return { stored: false, reason: 'method' };
    if (hasDirective(ccRequest, 'no-store') || hasDirective(ccResponse, 'no-store')) {
      return { stored: false, reason: 'no-store' };
    }
    if (hasDirective(ccResponse, 'private')) return { stored: false, reason: 'private' };
    if (req.headers.authorization !== undefined
        && !hasDirective(ccResponse, 'public')
        && !hasDirective(ccResponse, 's-maxage')
        && !hasDirective(ccResponse, 'must-revalidate')) {
      return { stored: false, reason: 'authorization' };
    }
    if (!CACHEABLE_STATUS.has(res.status)) return { stored: false, reason: 'status' };
    const varyNames = parseVary(res.headers);
    if (varyNames.includes('*')) return { stored: false, reason: 'vary' };

    const key = baseKey(req.method, req.url);
    const storedAt = clock();
    const entry = makeEntry(res, req, ccResponse, varyNames, storedAt);
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
    }
    const existing = matchEntry(group, req.headers);
    if (existing === null) {
      group.push(entry);
      entryCount += 1;
      evictIfNeeded();
    } else {
      group[group.indexOf(existing)] = entry;
    }
    if (countingStore) counters.stores += 1;
    return { stored: true, reason: 'stored', key };
  }

  return {
    store(request, response) {
      const req = validateRequest(request);
      const res = validateResponse(response);
      return admit(req, res, true);
    },

    lookup(request) {
      const req = validateRequest(request);
      const ccRequest = parseCacheControl(req.headers['cache-control']);
      // 请求 no-store：根本不碰缓存。
      if (hasDirective(ccRequest, 'no-store')) {
        counters.misses += 1;
        return miss();
      }

      const group = groups.get(baseKey(req.method, req.url));
      const entry = group === undefined ? null : matchEntry(group, req.headers);
      if (entry === null) {
        counters.misses += 1;
        return miss();
      }
      counters.hits += 1;

      const now = clock();
      entry.lastUsed = now;
      const ageHeader = integerHeader(entry.headers, 'age');
      const ageMs = (ageHeader === null ? 0 : ageHeader * 1000) + (now - entry.storedAt);

      const responseNoCache = hasDirective(entry.cc, 'no-cache');
      const requestMaxAge = integerDirective(ccRequest, 'max-age');
      const requestForcesRevalidation = hasDirective(ccRequest, 'no-cache') || requestMaxAge === 0;
      const fresh = ageMs < entry.freshnessMs;

      let status;
      let canServeStale = false;
      if (fresh && !responseNoCache && !requestForcesRevalidation) {
        status = 'fresh';
      } else if (responseNoCache || requestForcesRevalidation) {
        // no-cache（响应或请求）哪怕还新鲜，也必须先回源。
        status = 'must-revalidate';
      } else if (hasDirective(entry.cc, 'must-revalidate')) {
        // 过期之后不许拿旧的顶。
        status = 'must-revalidate';
      } else {
        status = 'stale';
        const swr = integerDirective(entry.cc, 'stale-while-revalidate');
        // 窗口从新鲜期结束那一刻往后算。
        if (swr !== null && ageMs < entry.freshnessMs + swr * 1000) {
          canServeStale = true;
        }
      }
      if (canServeStale) counters.staleServed += 1;

      return {
        hit: true,
        status,
        entry: { status: entry.status, headers: { ...entry.headers } },
        ageMs,
        freshnessMs: entry.freshnessMs,
        canServeStale,
        requiresRevalidation: status !== 'fresh' && !canServeStale,
      };
    },

    revalidate(request, response) {
      const req = validateRequest(request);
      const res = validateResponse(response);
      const key = baseKey(req.method, req.url);
      const group = groups.get(key);
      const entry = group === undefined ? null : matchEntry(group, req.headers);

      if (entry === null) {
        if (res.status === 304) return { action: 'ignored', reason: 'no-entry' };
        const report = admit(req, res, false);
        return report.stored
          ? { action: 'replaced', key: report.key }
          : { action: 'evicted', reason: report.reason };
      }

      // 真的处理了「有旧条目」才算一次 revalidations。
      counters.revalidations += 1;

      if (res.status === 304) {
        // 304 的头覆盖同名头，storedAt 归到这一刻，重算新鲜度。
        const headers = { ...entry.headers, ...res.headers };
        const cc = parseCacheControl(headers['cache-control']);
        const varyNames = parseVary(headers);
        const now = clock();
        entry.headers = headers;
        entry.cc = cc;
        entry.varyNames = varyNames;
        entry.varyValues = varyNames.map((name) => req.headers[name] ?? null);
        entry.storedAt = now;
        entry.lastUsed = now;
        entry.freshnessMs = computeFreshness(headers, cc, now);
        return { action: 'refreshed', key };
      }

      // 整份替换：先撤旧条目，再按 store 的规则处理新响应。
      removeEntry(group, entry);
      const report = admit(req, res, false);
      return report.stored
        ? { action: 'replaced', key: report.key }
        : { action: 'evicted', reason: report.reason };
    },

    purge(args) {
      if (!isObject(args) || typeof args.url !== 'string' || args.url.length === 0) {
        bad('ERR_BAD_ARGS', 'purge 需要 { url }，url 是非空字符串');
      }
      const { url } = args;
      let removed = 0;
      for (const method of ['GET', 'HEAD']) {
        const key = `${method} ${url}`;
        const group = groups.get(key);
        if (group !== undefined) {
          removed += group.length;
          groups.delete(key);
        }
      }
      entryCount -= removed;
      return { url, removed };
    },

    stats() {
      return {
        entries: entryCount,
        stores: counters.stores,
        hits: counters.hits,
        misses: counters.misses,
        revalidations: counters.revalidations,
        evictions: counters.evictions,
        staleServed: counters.staleServed,
      };
    },
  };
}
