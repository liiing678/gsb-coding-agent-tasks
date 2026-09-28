// 幂等层：同一个 Idempotency-Key 的同一个请求（同指纹）只真正执行一次，
// 并发的挂在这次执行上等结果，TTL 之内再来的直接回放缓存。
//
// createIdempotency({ config, metrics, now }) -> { handle(ctx) }
//   config  : configs/dev.json 里 idempotency 那一段（已经校验过）
//   metrics : src/metrics.js 的计数器，名字见 README
//   now     : 取当前时间的函数，默认 () => Date.now()；测试会塞假时钟
//
// handle({ req, res, body, handler })：语义见 README 的「幂等口径」。
// handler(req, recorder) 把结果写进 src/recorder.js 的录制器，什么时候写回 res 由这里决定。
import { createHash } from 'node:crypto';

import { createRecorder } from './recorder.js';

// 回放时只带这几个响应头，其余（set-cookie、date、hop-by-hop）一律不跟回去。
const REPLAYABLE_HEADERS = new Set(['content-type', 'cache-control', 'location', 'etag']);

const HANDLER_FAILED_BODY = Buffer.from(`${JSON.stringify({ error: 'handler_failed' })}\n`);

export function createIdempotency({ config, metrics, now = () => Date.now() } = {}) {
  const { ttlMs, maxEntries, maxWaiters, maxKeyBytes } = config;
  // key -> { kind: 'flight', ... }（在飞执行）或 { kind: 'cached', ... }（缓存结果）
  const store = new Map();

  // 指纹 = method + 原始 url + 请求体 sha256 十六进制，不做任何归一化。
  function fingerprintOf(req, body) {
    const digest = createHash('sha256').update(body).digest('hex');
    return `${req.method}\n${req.url}\n${digest}`;
  }

  function sendJson(res, status, payload) {
    const payloadBody = Buffer.from(`${JSON.stringify(payload)}\n`);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': payloadBody.length,
    });
    res.end(payloadBody);
  }

  // 把一份结果写回客户端；content-length 按实际 body 重算。
  function sendResult(res, result, { replay = false } = {}) {
    const headers = {};
    for (const [name, value] of result.headers) {
      headers[name] = value;
    }
    headers['content-length'] = result.body.length;
    if (replay) {
      headers['x-idem-replay'] = 'true';
    }
    res.writeHead(result.status, headers);
    res.end(result.body);
  }

  // 盯着客户端连接：结果还没写回就断开的，记一笔 idem_aborted_total。
  function watchClient(res) {
    let written = false;
    let closedEarly = false;
    res.on('close', () => {
      if (!written) {
        closedEarly = true;
      }
    });
    res.on('error', () => {});
    return {
      get gone() {
        return closedEarly || res.destroyed || res.writableEnded;
      },
      finish() {
        written = true;
      },
    };
  }

  function deliver(res, watcher, result, options) {
    if (watcher.gone) {
      watcher.finish();
      metrics.inc('idem_aborted_total');
      return;
    }
    watcher.finish();
    try {
      sendResult(res, result, options);
    } catch {
      metrics.inc('idem_aborted_total');
    }
  }

  // 真的执行一次 handler。抛错或没调 recorder.end() 都算失败：
  // 结果是 500，且不进缓存（cacheable = false）。
  async function execute(handler, req) {
    const recorder = createRecorder();
    try {
      await handler(req, recorder);
    } catch {
      return { cacheable: false, result: failureResult() };
    }
    const captured = recorder.captured();
    if (!captured.ended) {
      return { cacheable: false, result: failureResult() };
    }
    return {
      cacheable: true,
      result: {
        status: captured.status,
        headers: captured.headers.filter(([name]) => REPLAYABLE_HEADERS.has(name)),
        body: captured.body,
      },
    };
  }

  function failureResult() {
    return {
      status: 500,
      headers: [['content-type', 'application/json']],
      body: HANDLER_FAILED_BODY,
    };
  }

  // 缓存条目超上限时淘汰最久没用过的（在飞的不算）；回放会刷新 lastUsed。
  function evictIfNeeded() {
    let cachedCount = 0;
    for (const entry of store.values()) {
      if (entry.kind === 'cached') {
        cachedCount += 1;
      }
    }
    while (cachedCount > maxEntries) {
      let oldestKey = null;
      let oldestUsed = Infinity;
      for (const [key, entry] of store) {
        if (entry.kind === 'cached' && entry.lastUsed < oldestUsed) {
          oldestUsed = entry.lastUsed;
          oldestKey = key;
        }
      }
      store.delete(oldestKey);
      metrics.inc('idem_evicted_total');
      cachedCount -= 1;
    }
  }

  async function handle({ req, res, body, handler }) {
    const key = req.headers['idempotency-key'];

    // 没有 key（或空串）：不看也不缓存，直接交给 handler。
    if (typeof key !== 'string' || key === '') {
      metrics.inc('idem_passthrough_total');
      const recorder = createRecorder();
      await handler(req, recorder);
      const captured = recorder.captured();
      sendResult(res, {
        status: captured.status,
        headers: captured.headers,
        body: captured.body,
      });
      return;
    }

    if (Buffer.byteLength(key, 'utf8') > maxKeyBytes) {
      metrics.inc('idem_rejected_total');
      sendJson(res, 400, { error: 'invalid_idempotency_key' });
      return;
    }

    metrics.inc('idem_requests_total');
    const fingerprint = fingerprintOf(req, body);
    const existing = store.get(key);

    // 同 key 不同指纹：不管有没有在飞、有没有缓存，当场 409。
    if (existing && existing.fingerprint !== fingerprint) {
      metrics.inc('idem_conflicts_total');
      sendJson(res, 409, { error: 'idempotency_key_reuse' });
      return;
    }

    if (existing?.kind === 'cached') {
      if (now() - existing.createdAt < ttlMs) {
        existing.lastUsed = now();
        metrics.inc('idem_replayed_total');
        sendResult(res, existing.result, { replay: true });
        return;
      }
      store.delete(key);
    }

    if (existing?.kind === 'flight') {
      // 上一次还没跑完：挂上去等同一份结果，自己不执行。
      // 等待者不看 TTL——就算这次执行跑得比 TTL 还久，也等它出结果。
      if (existing.waiters >= maxWaiters) {
        metrics.inc('idem_rejected_total');
        sendJson(res, 503, { error: 'too_many_waiters' });
        return;
      }
      existing.waiters += 1;
      metrics.inc('idem_waited_total');
      const watcher = watchClient(res);
      const result = await existing.promise;
      existing.waiters -= 1;
      deliver(res, watcher, result);
      return;
    }

    // 没有在飞也没有能用的缓存：这次由我们执行，结果共享给等待者。
    let resolveFlight;
    const flight = {
      kind: 'flight',
      fingerprint,
      waiters: 0,
      promise: new Promise((resolve) => {
        resolveFlight = resolve;
      }),
    };
    store.set(key, flight);
    metrics.inc('idem_executed_total');

    const watcher = watchClient(res);
    const { cacheable, result } = await execute(handler, req);

    if (store.get(key) === flight) {
      if (cacheable) {
        store.set(key, {
          kind: 'cached',
          fingerprint,
          result,
          createdAt: now(),
          lastUsed: now(),
        });
        evictIfNeeded();
      } else {
        // 失败不进缓存，后面同键同指纹的请求会重新执行。
        store.delete(key);
      }
    }
    resolveFlight(result);
    deliver(res, watcher, result);
  }

  return { handle };
}
