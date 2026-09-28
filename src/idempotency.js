// 写接口外面那层幂等。
//
// createIdempotency({ config, metrics, now }) -> { handle(ctx) }
//   config  : configs/dev.json 里 idempotency 那一段（已经校验过）
//   metrics : src/metrics.js 的计数器，名字见 README
//   now     : 取当前时间的函数，默认 () => Date.now()；测试会塞假时钟
//
// handle({ req, res, body, handler })：语义见 README 的「幂等口径」。
// handler(req, recorder) 把结果写进 src/recorder.js 的录制器，什么时候写回 res 由这里决定。

import crypto from 'node:crypto';

import { createRecorder } from './recorder.js';

// 回放时只带这几个响应头，别的（set-cookie、date、hop-by-hop 那些）一律不跟。
const REPLAY_HEADERS = new Set([
  'content-type',
  'cache-control',
  'location',
  'etag',
]);

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export function createIdempotency({ config, metrics, now = () => Date.now() } = {}) {
  // key -> entry。Map 的迭代顺序同时承担 LRU 顺序：
  // 新执行完成入缓存、以及每次回放，都 delete 再 set 把条目挪到"最新"。
  const entries = new Map();

  function fingerprint(req, body) {
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    return `${req.method} ${req.url} ${hash}`;
  }

  function writeJsonError(res, status, error) {
    const payload = Buffer.from(JSON.stringify({ error }));
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': payload.length,
    });
    res.end(payload);
  }

  // 把一次执行的结果（成功或失败）写给一个客户端。
  // 写之前客户端已经走了就只记一笔 aborted，绝不能把执行本身带挂。
  function deliver(res, result, { replay = false } = {}) {
    if (res.destroyed || res.writableEnded || res.headersSent) {
      metrics.inc('idem_aborted_total');
      return;
    }

    const headers = {};
    if (replay) {
      for (const [name, value] of result.headers) {
        if (REPLAY_HEADERS.has(name)) {
          headers[name] = value;
        }
      }
      headers['x-idem-replay'] = 'true';
    } else {
      for (const [name, value] of result.headers) {
        headers[name] = value;
      }
    }
    headers['content-length'] = String(result.body.length);

    try {
      res.writeHead(result.status, headers);
      res.end(result.body);
    } catch {
      metrics.inc('idem_aborted_total');
    }
  }

  function failureResult() {
    const body = Buffer.from(JSON.stringify({ error: 'handler_failed' }));
    return {
      ok: false,
      status: 500,
      headers: [['content-type', 'application/json']],
      body,
    };
  }

  // 真正跑一次 handler。结果 resolve 给所有挂在上面的人；
  // 成功才进缓存，失败（抛错或没 end）不留任何东西。
  function execute({ req, handler, key, entry }) {
    metrics.inc('idem_executed_total');

    const recorder = createRecorder();

    const work = Promise.resolve()
      .then(() => handler(req, recorder))
      .then(() => {
        const captured = recorder.captured();
        if (!captured.ended) {
          return null;
        }
        const headers = captured.headers.filter(([name]) => REPLAY_HEADERS.has(name));
        return {
          ok: true,
          status: captured.status,
          headers,
          body: Buffer.from(captured.body),
        };
      })
      .catch(() => null);

    return work.then((success) => {
      // 在飞条目先摘掉，成功再以缓存条目放回来（顺便排到 LRU 最新）。
      if (entries.get(key) === entry) {
        entries.delete(key);
      }

      if (!success) {
        const failed = failureResult();
        entry.done = true;
        entry.result = failed;
        for (const waiter of entry.waiters) {
          waiter(failed);
        }
        return failed;
      }

      entry.done = true;
      entry.result = success;
      entry.expiresAt = now() + config.ttlMs;
      entries.set(key, entry);

      for (const waiter of entry.waiters) {
        waiter(success);
      }
      return success;
    });
  }

  // 没有 key：不看也不缓存，直接交给 handler。
  async function runPassthrough({ req, res, body, handler }) {
    metrics.inc('idem_passthrough_total');
    const recorder = createRecorder();
    let captured;
    try {
      await handler(req, recorder);
      captured = recorder.captured();
      if (!captured.ended) {
        throw new Error('handler 没有结束响应');
      }
    } catch {
      if (!res.destroyed && !res.writableEnded && !res.headersSent) {
        writeJsonError(res, 500, 'handler_failed');
      }
      return;
    }

    if (res.destroyed || res.writableEnded || res.headersSent) {
      return;
    }
    const headers = Object.fromEntries(captured.headers);
    headers['content-length'] = String(captured.body.length);
    res.writeHead(captured.status, headers);
    res.end(captured.body);
  }

  return {
    async handle({ req, res, body, handler }) {
      const key = req.headers['idempotency-key'];

      // 客户端断开可能在写入途中异步冒 'error' 出来；写不回就写不回，
      // 不能让一个 socket 错误把整个进程带挂。
      res.on('error', () => {});

      if (key === undefined || key === null || key === '') {
        await runPassthrough({ req, res, body, handler });
        return;
      }
      if (Buffer.byteLength(String(key)) > config.maxKeyBytes) {
        metrics.inc('idem_rejected_total');
        writeJsonError(res, 400, 'invalid_idempotency_key');
        return;
      }

      metrics.inc('idem_requests_total');
      const fp = fingerprint(req, body);
      const existing = entries.get(key);

      if (existing) {
        // key 一旦绑了指纹，换指纹就是另一件事：不管在飞还是缓存，当场 409。
        if (existing.fingerprint !== fp) {
          metrics.inc('idem_conflicts_total');
          writeJsonError(res, 409, 'idempotency_key_reuse');
          return;
        }

        if (!existing.done) {
          if (existing.waiters.length >= config.maxWaiters) {
            metrics.inc('idem_rejected_total');
            writeJsonError(res, 503, 'too_many_waiters');
            return;
          }
          metrics.inc('idem_waited_total');
          const result = await new Promise((resolve) => {
            existing.waiters.push(resolve);
          });
          deliver(res, result);
          return;
        }

        if (now() < existing.expiresAt) {
          // 回放算"用过"：挪到 LRU 最新。
          entries.delete(key);
          entries.set(key, existing);
          metrics.inc('idem_replayed_total');
          deliver(res, existing.result, { replay: true });
          return;
        }

        // 缓存过期：同键同指纹重新执行一遍。
        entries.delete(key);
      }

      // 新执行前先腾地方：淘汰最久没用过的缓存条目（在飞的不算）。
      if (entries.size >= config.maxEntries) {
        for (const [oldKey, oldEntry] of entries) {
          if (!oldEntry.done) {
            continue;
          }
          entries.delete(oldKey);
          metrics.inc('idem_evicted_total');
          break;
        }
      }

      const entry = {
        fingerprint: fp,
        done: false,
        result: null,
        expiresAt: 0,
        waiters: [],
      };
      entries.set(key, entry);

      const result = await execute({ req, handler, key, entry });
      // 发起者这边客户端可能已经走了；执行本身不受影响，结果也照常留在缓存里。
      deliver(res, result);
    },
  };
}
