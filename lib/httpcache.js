// HTTP 缓存语义层，口径见 README 的《口径》和《API》两节。
import { HttpCacheError } from './errors.js';

export const DEFAULTS = {
  maxEntries: 100,
  heuristicFraction: 0.1,
};

const CACHEABLE_STATUS = new Set([200, 203, 204, 300, 301, 308, 404, 405, 410, 414, 501]);
const INTEGER = /^-?\d+$/;

function fail(code, message, details) {
  throw new HttpCacheError(code, message, details);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 头名一律折成小写；值必须是字符串。
function normalizeHeaders(headers, code, label) {
  if (headers === undefined) return {};
  if (!isObject(headers)) fail(code, `${label}必须是一个对象`);
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') {
      fail(code, `${label} ${name} 的值必须是字符串`, { header: name });
    }
    out[name.toLowerCase()] = value;
  }
  return out;
}

// Cache-Control：按 "," 切开、名字小写、值去掉两侧引号。
function parseCacheControl(value) {
  const directives = new Map();
  if (typeof value !== 'string') return directives;
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      directives.set(trimmed.toLowerCase(), true);
      continue;
    }
    const name = trimmed.slice(0, eq).trim().toLowerCase();
    let val = trimmed.slice(eq + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    directives.set(name, val);
  }
  return directives;
}

// 要数字的指令：值不是十进制整数就当没写。
function intDirective(directives, name) {
  const value = directives.get(name);
  if (typeof value !== 'string' || !INTEGER.test(value)) return null;
  return Number.parseInt(value, 10);
}

function parseHttpDate(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function parseVary(value) {
  if (typeof value !== 'string') return null;
  const names = value.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  return names.length > 0 ? names : null;
}

function checkRequest(request) {
  if (!isObject(request)) fail('ERR_BAD_REQUEST', 'request 必须是一个对象');
  if (typeof request.method !== 'string' || request.method.length === 0) {
    fail('ERR_BAD_REQUEST', 'request.method 必须是非空字符串');
  }
  if (typeof request.url !== 'string' || request.url.length === 0) {
    fail('ERR_BAD_REQUEST', 'request.url 必须是非空字符串');
  }
  return {
    method: request.method,
    url: request.url,
    headers: normalizeHeaders(request.headers, 'ERR_BAD_REQUEST', '请求头'),
  };
}

function checkResponse(response) {
  if (!isObject(response)) fail('ERR_BAD_RESPONSE', 'response 必须是一个对象');
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    fail('ERR_BAD_RESPONSE', 'response.status 必须是 100..599 的整数');
  }
  return {
    status: response.status,
    headers: normalizeHeaders(response.headers, 'ERR_BAD_RESPONSE', '响应头'),
  };
}

export function createHttpCache(config = {}) {
  if (!isObject(config)) fail('ERR_BAD_CONFIG', 'config 必须是一个对象');
  const {
    clock = () => Date.now(),
    maxEntries = DEFAULTS.maxEntries,
    heuristicFraction = DEFAULTS.heuristicFraction,
  } = config;
  if (typeof clock !== 'function') fail('ERR_BAD_CONFIG', 'clock 必须是一个函数');
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    fail('ERR_BAD_CONFIG', 'maxEntries 必须是正整数');
  }
  if (typeof heuristicFraction !== 'number' || !(heuristicFraction >= 0 && heuristicFraction <= 1)) {
    fail('ERR_BAD_CONFIG', 'heuristicFraction 必须在 [0, 1] 之间');
  }

  // baseKey（"<方法> <url>"）-> 该 URL 的所有变体条目
  const groups = new Map();
  let usageCounter = 0;
  const counters = {
    stores: 0,
    hits: 0,
    misses: 0,
    revalidations: 0,
    evictions: 0,
    staleServed: 0,
  };

  function now() {
    const value = clock();
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail('ERR_BAD_CONFIG', 'clock 必须返回有限数');
    }
    return value;
  }

  function totalEntries() {
    let total = 0;
    for (const group of groups.values()) total += group.length;
    return total;
  }

  function ageHeaderMs(headers) {
    const value = headers.age;
    if (typeof value === 'string' && INTEGER.test(value.trim())) {
      return Number.parseInt(value.trim(), 10) * 1000;
    }
    return 0;
  }

  // 新鲜期：s-maxage > max-age > Expires > Last-Modified 启发式 > 0。
  function computeFreshnessMs(headers, storedAt) {
    const cc = parseCacheControl(headers['cache-control']);
    const sMaxage = intDirective(cc, 's-maxage');
    if (sMaxage !== null) return sMaxage * 1000;
    const maxAge = intDirective(cc, 'max-age');
    if (maxAge !== null) return maxAge * 1000;
    const expires = parseHttpDate(headers.expires);
    if (expires !== null) {
      const date = parseHttpDate(headers.date) ?? storedAt;
      return expires - date;
    }
    const lastModified = parseHttpDate(headers['last-modified']);
    const date = parseHttpDate(headers.date);
    if (lastModified !== null && date !== null && date > lastModified) {
      return Math.floor((date - lastModified) * heuristicFraction);
    }
    return 0;
  }

  // 能不能存：按 README 表格的顺序检查，返回 reason 或 null。
  function storableReason(req, res) {
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return 'method';
    const reqCc = parseCacheControl(req.headers['cache-control']);
    const resCc = parseCacheControl(res.headers['cache-control']);
    if (reqCc.has('no-store') || resCc.has('no-store')) return 'no-store';
    if (resCc.has('private')) return 'private';
    if (
      req.headers.authorization !== undefined
      && !resCc.has('public') && !resCc.has('s-maxage') && !resCc.has('must-revalidate')
    ) {
      return 'authorization';
    }
    if (!CACHEABLE_STATUS.has(res.status)) return 'status';
    const vary = parseVary(res.headers.vary);
    if (vary !== null && vary.includes('*')) return 'vary';
    return null;
  }

  function varySignature(vary, varyValues) {
    if (vary === null) return null;
    return JSON.stringify(vary.map((name) => [name, varyValues[name]]));
  }

  // 条目的 Vary 与这次请求的头值比对：缺头按 null 比。
  function varyMatches(entry, reqHeaders) {
    if (entry.vary === null) return true;
    return entry.vary.every((name) => (reqHeaders[name] ?? null) === entry.varyValues[name]);
  }

  function evictIfNeeded() {
    while (totalEntries() > maxEntries) {
      let worstKey = null;
      let worstIndex = -1;
      let worstUsed = Infinity;
      for (const [key, group] of groups) {
        group.forEach((entry, index) => {
          if (entry.lastUsed < worstUsed) {
            worstUsed = entry.lastUsed;
            worstKey = key;
            worstIndex = index;
          }
        });
      }
      const group = groups.get(worstKey);
      group.splice(worstIndex, 1);
      if (group.length === 0) groups.delete(worstKey);
      counters.evictions += 1;
    }
  }

  function doStore(req, res, storedAt) {
    const vary = parseVary(res.headers.vary);
    const varyValues = {};
    if (vary !== null) {
      for (const name of vary) varyValues[name] = req.headers[name] ?? null;
    }
    const entry = {
      url: req.url,
      status: res.status,
      headers: { ...res.headers },
      storedAt,
      initialAgeMs: ageHeaderMs(res.headers),
      freshnessMs: computeFreshnessMs(res.headers, storedAt),
      vary,
      varyValues,
      lastUsed: ++usageCounter,
    };
    const key = `${req.method} ${req.url}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    const signature = varySignature(vary, varyValues);
    const index = group.findIndex((e) => varySignature(e.vary, e.varyValues) === signature);
    if (index >= 0) group[index] = entry;
    else group.push(entry);
    counters.stores += 1;
    evictIfNeeded();
    return key;
  }

  function store(request, response) {
    const req = checkRequest(request);
    const res = checkResponse(response);
    const reason = storableReason(req, res);
    if (reason !== null) return { stored: false, reason };
    const key = doStore(req, res, now());
    return { stored: true, reason: 'stored', key };
  }

  function miss() {
    counters.misses += 1;
    return {
      hit: false,
      status: 'miss',
      entry: null,
      ageMs: null,
      freshnessMs: null,
      canServeStale: false,
      requiresRevalidation: true,
    };
  }

  function lookup(request) {
    const req = checkRequest(request);
    const reqCc = parseCacheControl(req.headers['cache-control']);
    if (reqCc.has('no-store')) return miss();
    const group = groups.get(`${req.method} ${req.url}`);
    const entry = group ? group.find((e) => varyMatches(e, req.headers)) : undefined;
    if (!entry) return miss();

    entry.lastUsed = ++usageCounter;
    counters.hits += 1;
    const ageMs = entry.initialAgeMs + (now() - entry.storedAt);
    const freshnessMs = entry.freshnessMs;
    const resCc = parseCacheControl(entry.headers['cache-control']);
    const fresh = ageMs < freshnessMs;

    let status;
    if (resCc.has('no-cache') || reqCc.has('no-cache') || intDirective(reqCc, 'max-age') === 0) {
      status = 'must-revalidate';
    } else if (fresh) {
      status = 'fresh';
    } else if (resCc.has('must-revalidate')) {
      status = 'must-revalidate';
    } else {
      status = 'stale';
    }

    const swr = intDirective(resCc, 'stale-while-revalidate');
    const canServeStale = status === 'stale' && swr !== null && ageMs < freshnessMs + swr * 1000;
    if (canServeStale) counters.staleServed += 1;
    return {
      hit: true,
      status,
      entry: { status: entry.status, headers: { ...entry.headers } },
      ageMs,
      freshnessMs,
      canServeStale,
      requiresRevalidation: status !== 'fresh' && !canServeStale,
    };
  }

  function revalidate(request, response) {
    const req = checkRequest(request);
    const res = checkResponse(response);
    const key = `${req.method} ${req.url}`;
    const group = groups.get(key);
    const index = group ? group.findIndex((e) => varyMatches(e, req.headers)) : -1;
    const existing = index >= 0 ? group[index] : null;

    if (res.status === 304) {
      if (!existing) return { action: 'ignored', reason: 'no-entry' };
      // 304 的头覆盖同名头，时间归到这一刻，新鲜度重算。
      existing.headers = { ...existing.headers, ...res.headers };
      existing.storedAt = now();
      existing.initialAgeMs = ageHeaderMs(existing.headers);
      existing.freshnessMs = computeFreshnessMs(existing.headers, existing.storedAt);
      existing.lastUsed = ++usageCounter;
      counters.revalidations += 1;
      return { action: 'refreshed', key };
    }

    if (existing) {
      group.splice(index, 1);
      if (group.length === 0) groups.delete(key);
      counters.revalidations += 1;
    }
    const reason = storableReason(req, res);
    if (reason !== null) return { action: 'evicted', reason };
    doStore(req, res, now());
    return { action: 'replaced', key };
  }

  function purge(args) {
    if (!isObject(args) || typeof args.url !== 'string' || args.url.length === 0) {
      fail('ERR_BAD_ARGS', 'purge 需要 { url }，且 url 是非空字符串');
    }
    let removed = 0;
    for (const [key, group] of [...groups]) {
      for (let i = group.length - 1; i >= 0; i -= 1) {
        if (group[i].url === args.url) {
          group.splice(i, 1);
          removed += 1;
        }
      }
      if (group.length === 0) groups.delete(key);
    }
    return { url: args.url, removed };
  }

  function stats() {
    return {
      entries: totalEntries(),
      stores: counters.stores,
      hits: counters.hits,
      misses: counters.misses,
      revalidations: counters.revalidations,
      evictions: counters.evictions,
      staleServed: counters.staleServed,
    };
  }

  return { store, lookup, revalidate, purge, stats };
}
