// createGuard({ config, counters, transport, now, sleep, random }) -> { call(request), snapshot() }
// 语义见 README 的《接口》和《口径》：一份总预算管住尝试/退避/Retry-After/排队，
// 熔断、并发、队列都按 upstream 名分开算。

import { EgressError, ErrorKind, Reason, isFailureStatus } from './errors.js';
import { send as defaultTransport } from './upstream.js';

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

function createUpstreamState() {
  return {
    state: 'closed', // 'closed' | 'open' | 'half-open'
    window: [], // 最近 windowSize 次真实尝试，true = 失败
    openedAt: 0,
    consecutiveOpens: 0,
    probesInFlight: 0,
    probeSuccesses: 0,
    inFlight: 0,
    queue: [],
  };
}

// Retry-After 支持秒数和 HTTP-date；HTTP-date 用注入的 now 换算成等待毫秒数。
function parseRetryAfter(headers, now) {
  if (!headers) {
    return null;
  }
  let raw;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'retry-after') {
      raw = value;
      break;
    }
  }
  if (raw === undefined) {
    return null;
  }
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) {
    return Number(text) * 1000;
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) {
    return null;
  }
  return Math.max(0, at - now());
}

export function createGuard({
  config,
  counters,
  transport = defaultTransport,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
} = {}) {
  if (!config) {
    throw new Error('createGuard 需要 config');
  }
  if (!counters) {
    throw new Error('createGuard 需要 counters');
  }

  const upstreams = new Map();
  const stateOf = (name) => {
    let state = upstreams.get(name);
    if (!state) {
      state = createUpstreamState();
      upstreams.set(name, state);
      return state;
    }
    return state;
  };

  // 还允许发起一次尝试的最低剩余预算。
  const minRemaining = () => config.attemptTimeoutMs * config.minAttemptRatio;

  // 冷却时长随连续打开次数翻倍，封顶 cooldownMaxMs。
  function currentCooldown(state) {
    const grown =
      config.breaker.cooldownMs *
      config.breaker.openBackoffFactor ** Math.max(0, state.consecutiveOpens - 1);
    return Math.min(grown, config.breaker.cooldownMaxMs);
  }

  function breakerReject(name) {
    counters.inc('egress_breaker_rejected_total');
    throw new EgressError(ErrorKind.BREAKER, `上游 ${name} 熔断中，快速失败`, {
      reason: Reason.BREAKER_OPEN,
      upstream: name,
      attempts: 0,
    });
  }

  // 熔断门：返回这次调用是不是半开探测；被挡下就直接抛。
  function gate(state, name) {
    if (state.state === 'open') {
      if (now() - state.openedAt >= currentCooldown(state)) {
        state.state = 'half-open';
        state.probeSuccesses = 0;
      } else {
        breakerReject(name);
      }
    }
    if (state.state === 'half-open') {
      if (state.probesInFlight >= config.breaker.probeConcurrency) {
        breakerReject(name);
      }
      state.probesInFlight += 1;
      return true;
    }
    return false;
  }

  // 记录一次真实尝试的结果；只在 closed 状态下评估要不要打开。
  function recordSample(state, failed) {
    state.window.push(failed);
    if (state.window.length > config.breaker.windowSize) {
      state.window.shift();
    }
    if (state.state !== 'closed' || state.window.length < config.breaker.minSamples) {
      return;
    }
    const failures = state.window.filter(Boolean).length;
    if (failures / state.window.length >= config.breaker.failureRatio) {
      state.state = 'open';
      state.consecutiveOpens += 1;
      state.openedAt = now();
      state.probeSuccesses = 0;
    }
  }

  // 并发占坑：满了就排队，队列也满了就当场失败。占坑要同步发生，
  // 不然同一拍进来的调用会都以为自己有位置。
  function acquire(state, name) {
    if (state.inFlight < config.bulkhead.maxConcurrency) {
      state.inFlight += 1;
      return Promise.resolve();
    }
    if (state.queue.length >= config.bulkhead.queueLimit) {
      counters.inc('egress_queue_full_total');
      return Promise.reject(
        new EgressError(ErrorKind.QUEUE, `上游 ${name} 并发已满，队列也排不下`, {
          reason: Reason.QUEUE_FULL,
          upstream: name,
          attempts: 0,
        }),
      );
    }
    counters.inc('egress_queue_waited_total');
    return new Promise((resolve) => {
      state.queue.push(resolve);
    });
  }

  function release(state) {
    state.inFlight -= 1;
    const next = state.queue.shift();
    if (next) {
      state.inFlight += 1;
      next();
    }
  }

  async function call(request) {
    counters.inc('egress_calls_total');
    const name = request.upstream;
    const state = stateOf(name);
    const start = now();
    const deadline = start + (request.budgetMs ?? config.budgetMs);
    const method = (request.method ?? 'GET').toUpperCase();
    const idempotent = request.idempotent ?? IDEMPOTENT_METHODS.has(method);

    const isProbe = gate(state, name);
    let acquired = false;
    try {
      await acquire(state, name);
      acquired = true;
      return await runAttempts();
    } finally {
      if (acquired) {
        release(state);
      }
      if (isProbe) {
        state.probesInFlight = Math.max(0, state.probesInFlight - 1);
      }
    }

    function failure(last, reason, attempts) {
      return new EgressError(
        last ? last.kind : ErrorKind.BUDGET,
        last ? last.message : `上游 ${name} 的调用预算已经不够发起尝试`,
        {
          status: last ? last.status : 0,
          reason,
          upstream: name,
          attempts,
        },
      );
    }

    async function runAttempts() {
      let attempts = 0;
      let last = null; // 最后一次失败：{ kind, status, message }

      for (;;) {
        const remaining = deadline - now();
        if (remaining < minRemaining()) {
          counters.inc('egress_budget_exhausted_total');
          throw failure(last, Reason.BUDGET_EXHAUSTED, attempts);
        }
        const timeoutMs = Math.min(config.attemptTimeoutMs, remaining);
        counters.inc('egress_attempts_total');
        if (attempts > 0) {
          counters.inc('egress_retries_total');
        }
        attempts += 1;

        let response = null;
        let error = null;
        try {
          response = await transport(request, { timeoutMs });
        } catch (caught) {
          error = caught;
        }
        const failed = error !== null || isFailureStatus(response.status);
        recordSample(state, failed);

        if (!failed) {
          if (isProbe) {
            state.probeSuccesses += 1;
            if (state.probeSuccesses >= config.breaker.probeSuccesses) {
              state.state = 'closed';
              state.window = [];
              state.consecutiveOpens = 0;
              state.probeSuccesses = 0;
            }
          }
          return {
            status: response.status,
            headers: response.headers,
            body: response.body,
            attempts,
            elapsedMs: now() - start,
          };
        }

        const kind = error ? (error.kind ?? ErrorKind.CONNECT) : ErrorKind.STATUS;
        const status = error ? (error.status ?? 0) : response.status;
        last = {
          kind,
          status,
          message: error ? error.message : `上游 ${name} 回了 ${status}`,
        };

        if (isProbe) {
          // 探测挂一次就立刻回到打开，这次调用到此为止。
          state.state = 'open';
          state.consecutiveOpens += 1;
          state.openedAt = now();
          state.probeSuccesses = 0;
          throw failure(last, Reason.NON_RETRYABLE, attempts);
        }

        const retryable = error
          ? kind === ErrorKind.CONNECT || kind === ErrorKind.TIMEOUT
          : RETRYABLE_STATUSES.has(status);
        if (!idempotent || !retryable) {
          throw failure(last, Reason.NON_RETRYABLE, attempts);
        }
        if (attempts >= config.maxAttempts) {
          throw failure(last, Reason.MAX_ATTEMPTS, attempts);
        }

        const retryAfterMs = error ? null : parseRetryAfter(response.headers, now);
        if (retryAfterMs !== null) {
          // 先算账：等完还不够再跑一次就不等，直接放弃。
          if (now() + retryAfterMs + minRemaining() > deadline) {
            counters.inc('egress_retry_after_exhausted_total');
            throw failure(last, Reason.RETRY_AFTER_EXHAUSTED, attempts);
          }
          if (retryAfterMs > 0) {
            await sleep(retryAfterMs);
          }
          continue;
        }

        const delay =
          Math.min(
            config.backoff.baseMs * config.backoff.factor ** (attempts - 1),
            config.backoff.maxMs,
          ) +
          random() * config.backoff.jitterMs;
        if (delay > 0) {
          await sleep(delay);
        }
      }
    }
  }

  function snapshot() {
    const upstreamEntries = {};
    for (const [name, state] of upstreams) {
      upstreamEntries[name] = {
        state: state.state,
        inFlight: state.inFlight,
        queued: state.queue.length,
      };
    }
    return { upstreams: upstreamEntries, counters: counters.snapshot() };
  }

  return { call, snapshot };
}
