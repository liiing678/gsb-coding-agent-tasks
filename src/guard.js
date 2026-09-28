import { randomInt } from 'node:crypto';

import { EgressError, ErrorKind, Reason, isFailureStatus } from './errors.js';
import { send } from './upstream.js';

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export function createGuard({
  config,
  counters,
  transport = send,
  now = () => new Date().getTime(),
  sleep = (ms) =>
    new Promise((resolve) => {
      AbortSignal.timeout(ms).addEventListener('abort', resolve, { once: true });
    }),
  random = () => randomInt(0, 2 ** 32) / 2 ** 32,
} = {}) {
  if (!config) throw new Error('createGuard 需要 config');
  if (!counters) throw new Error('createGuard 需要 counters');

  const CLOSED = 'closed';
  const OPEN = 'open';
  const HALF_OPEN = 'half-open';
  const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  const upstreams = new Map();

  const stateFor = (name) => {
    let state = upstreams.get(name);
    if (!state) {
      state = {
        name,
        state: CLOSED,
        results: [],
        openCount: 0,
        openedAt: 0,
        currentCooldown: 0,
        inFlight: 0,
        queue: [],
        probeCounts: new Map(),
        probeSuccesses: 0,
        generation: 0,
      };
      upstreams.set(name, state);
    }
    return state;
  };

  function refreshState(state) {
    if (state.state === OPEN && now() >= state.openedAt + state.currentCooldown) {
      state.state = HALF_OPEN;
      state.probeSuccesses = 0;
      state.generation += 1;
      state.probeCounts.set(state.generation, 0);
    }
  }

  function breakerError(name, attempts) {
    counters.inc('egress_breaker_rejected_total');
    return new EgressError(ErrorKind.BREAKER, `上游 ${name} 熔断打开`, {
      upstream: name,
      reason: Reason.BREAKER_OPEN,
      attempts,
    });
  }

  function rejectQueued(state) {
    const queued = state.queue.splice(0);
    for (const waiter of queued) waiter.reject(breakerError(state.name, 0));
  }

  function probeCount(state, generation = state.generation) {
    return state.probeCounts.get(generation) ?? 0;
  }

  function addProbe(state, generation) {
    state.probeCounts.set(generation, probeCount(state, generation) + 1);
  }

  function finishProbe(state, generation) {
    state.probeCounts.set(generation, Math.max(0, probeCount(state, generation) - 1));
  }

  function openCircuit(state) {
    state.state = OPEN;
    state.openCount += 1;
    state.openedAt = now();
    state.currentCooldown = Math.min(
      config.breaker.cooldownMs * config.breaker.openBackoffFactor ** (state.openCount - 1),
      config.breaker.cooldownMaxMs,
    );
    rejectQueued(state);
  }

  function closeCircuit(state) {
    state.state = CLOSED;
    state.openCount = 0;
    state.results = [];
    state.probeSuccesses = 0;
  }

  function shouldOpen(state) {
    if (state.results.length < config.breaker.minSamples) return false;
    const failures = state.results.filter((success) => !success).length;
    return failures / state.results.length >= config.breaker.failureRatio;
  }

  function recordOutcome(state, success, execution) {
    state.results.push(success);
    if (state.results.length > config.breaker.windowSize) state.results.shift();

    if (execution.probe && execution.generation === state.generation && state.state === HALF_OPEN) {
      if (success) {
        state.probeSuccesses += 1;
        if (state.probeSuccesses >= config.breaker.probeSuccesses) closeCircuit(state);
      } else {
        openCircuit(state);
      }
      return;
    }

    if (state.state === CLOSED && shouldOpen(state)) openCircuit(state);
  }

  function canAttempt(state, deadline) {
    refreshState(state);
    return deadline - now() >= config.attemptTimeoutMs * config.minAttemptRatio;
  }

  function admit(state, deadline) {
    refreshState(state);
    if (state.state === OPEN)
      return { type: 'rejected', kind: ErrorKind.BREAKER, reason: Reason.BREAKER_OPEN };
    if (!canAttempt(state, deadline))
      return { type: 'rejected', kind: ErrorKind.BUDGET, reason: Reason.BUDGET_EXHAUSTED };
    if (state.state === HALF_OPEN && probeCount(state) >= config.breaker.probeConcurrency)
      return { type: 'rejected', kind: ErrorKind.BREAKER, reason: Reason.BREAKER_OPEN };

    if (state.inFlight >= config.bulkhead.maxConcurrency) {
      if (state.queue.length >= config.bulkhead.queueLimit)
        return { type: 'rejected', kind: ErrorKind.QUEUE, reason: Reason.QUEUE_FULL };
      counters.inc('egress_queue_waited_total');
      return {
        type: 'queued',
        entry: new Promise((resolve, reject) => state.queue.push({ resolve, reject })),
      };
    }

    const probe = state.state === HALF_OPEN;
    state.inFlight += 1;
    if (probe) addProbe(state, state.generation);
    return { type: 'accepted', probe, generation: state.generation };
  }

  function pumpQueue(state) {
    refreshState(state);
    if (state.queue.length === 0 || state.state === OPEN) return;
    if (state.state === HALF_OPEN && probeCount(state) >= config.breaker.probeConcurrency) return;

    const waiter = state.queue.shift();
    state.inFlight += 1;
    const probe = state.state === HALF_OPEN;
    if (probe) addProbe(state, state.generation);
    waiter.resolve({ probe, generation: state.generation });
  }

  function releaseSlot(state, execution) {
    state.inFlight = Math.max(0, state.inFlight - 1);
    if (execution.probe) finishProbe(state, execution.generation);
    pumpQueue(state);
  }

  function rejectionError(admission, name) {
    if (admission.kind === ErrorKind.QUEUE) counters.inc('egress_queue_full_total');
    else if (admission.kind === ErrorKind.BREAKER)
      counters.inc('egress_breaker_rejected_total');
    else counters.inc('egress_budget_exhausted_total');

    const messages = {
      [ErrorKind.QUEUE]: `上游 ${name} 队列已满`,
      [ErrorKind.BREAKER]: `上游 ${name} 熔断打开`,
      [ErrorKind.BUDGET]: `上游 ${name} 预算耗尽`,
    };
    return new EgressError(admission.kind, messages[admission.kind], {
      upstream: name,
      reason: admission.reason,
    });
  }

  function transportError(error, name, attempts) {
    if (error instanceof EgressError) {
      return new EgressError(error.kind, error.message, {
        status: error.status ?? 0,
        upstream: name,
        attempts,
        cause: error,
      });
    }
    return new EgressError(ErrorKind.CONNECT, `连不上上游 ${name}: ${error?.message ?? error}`, {
      upstream: name,
      attempts,
      cause: error,
    });
  }

  function statusError(status, name, attempts) {
    return new EgressError(ErrorKind.STATUS, `上游 ${name} 返回 ${status}`, {
      status,
      upstream: name,
      attempts,
    });
  }

  function withReason(error, reason, attempts) {
    return new EgressError(error.kind, error.message, {
      status: error.status ?? 0,
      upstream: error.upstream,
      reason,
      attempts,
      cause: error,
    });
  }

  function budgetError(error, name, attempts) {
    counters.inc('egress_budget_exhausted_total');
    if (error) return withReason(error, Reason.BUDGET_EXHAUSTED, attempts);
    return new EgressError(ErrorKind.BUDGET, `上游 ${name} 预算耗尽`, {
      upstream: name,
      reason: Reason.BUDGET_EXHAUSTED,
      attempts,
    });
  }

  function retryAfterMs(headers, currentNow) {
    let value;
    if (headers && typeof headers.get === 'function') value = headers.get('retry-after');
    else if (headers) {
      const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after');
      value = entry?.[1];
    }
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    if (/^\d+$/.test(text)) return Number(text) * 1000;
    const at = Date.parse(text);
    return Number.isNaN(at) ? null : Math.max(0, at - currentNow);
  }

  const retryableStatus = (status) => [429, 502, 503, 504].includes(status);

  return {
    async call(request = {}) {
      counters.inc('egress_calls_total');
      const name = request.upstream;
      const state = stateFor(name);
      const start = now();
      const deadline = start + (request.budgetMs ?? config.budgetMs);
      const method = (request.method ?? 'GET').toUpperCase();
      const idempotent =
        request.idempotent === true ||
        (request.idempotent === undefined && IDEMPOTENT_METHODS.has(method));
      const transportRequest = { ...request, method };
      const execution = { probe: false, generation: state.generation, held: false };
      let attempts = 0;
      let lastError = null;

      try {
        const admission = admit(state, deadline);
        if (admission.type === 'rejected') throw rejectionError(admission, name);
        if (admission.type === 'queued') {
          const grant = await admission.entry;
          execution.probe = grant.probe;
          execution.generation = grant.generation;
          execution.held = true;
          if (!canAttempt(state, deadline)) throw budgetError(null, name, 0);
        } else {
          execution.probe = admission.probe;
          execution.generation = admission.generation;
          execution.held = true;
        }

        while (true) {
          const remaining = deadline - now();
          if (remaining < config.attemptTimeoutMs * config.minAttemptRatio)
            throw budgetError(lastError, name, attempts);

          attempts += 1;
          counters.inc('egress_attempts_total');
          if (attempts > 1) counters.inc('egress_retries_total');

          let response;
          try {
            response = await transport(transportRequest, {
              timeoutMs: Math.min(config.attemptTimeoutMs, remaining),
            });
          } catch (error) {
            lastError = transportError(error, name, attempts);
            recordOutcome(state, false, execution);

            if (execution.probe || !idempotent)
              throw withReason(lastError, Reason.NON_RETRYABLE, attempts);
            if (attempts >= config.maxAttempts)
              throw withReason(lastError, Reason.MAX_ATTEMPTS, attempts);
            if (state.state === OPEN) throw breakerError(name, attempts);

            const delay =
              Math.min(
                config.backoff.baseMs * config.backoff.factor ** (attempts - 1),
                config.backoff.maxMs,
              ) +
              random() * config.backoff.jitterMs;
            if (deadline - now() - delay < config.attemptTimeoutMs * config.minAttemptRatio)
              throw budgetError(lastError, name, attempts);
            await sleep(delay);

            refreshState(state);
            if (state.state === OPEN) throw breakerError(name, attempts);
            if (state.state === HALF_OPEN) {
              if (probeCount(state) >= config.breaker.probeConcurrency)
                throw breakerError(name, attempts);
              execution.probe = true;
              execution.generation = state.generation;
              addProbe(state, state.generation);
            }
            continue;
          }

          if (!isFailureStatus(response.status)) {
            recordOutcome(state, true, execution);
            return { ...response, attempts, elapsedMs: now() - start };
          }

          lastError = statusError(response.status, name, attempts);
          recordOutcome(state, false, execution);

          if (execution.probe || !retryableStatus(response.status) || !idempotent)
            throw withReason(lastError, Reason.NON_RETRYABLE, attempts);
          if (attempts >= config.maxAttempts)
            throw withReason(lastError, Reason.MAX_ATTEMPTS, attempts);
          if (state.state === OPEN) throw breakerError(name, attempts);

          const retryAfter = retryAfterMs(response.headers, now());
          let delay;
          if (retryAfter !== null) {
            if (deadline - now() - retryAfter < config.attemptTimeoutMs * config.minAttemptRatio) {
              counters.inc('egress_retry_after_exhausted_total');
              throw withReason(lastError, Reason.RETRY_AFTER_EXHAUSTED, attempts);
            }
            delay = retryAfter;
          } else {
            delay =
              Math.min(
                config.backoff.baseMs * config.backoff.factor ** (attempts - 1),
                config.backoff.maxMs,
              ) +
              random() * config.backoff.jitterMs;
            if (deadline - now() - delay < config.attemptTimeoutMs * config.minAttemptRatio)
              throw budgetError(lastError, name, attempts);
          }
          await sleep(delay);

          refreshState(state);
          if (state.state === OPEN) throw breakerError(name, attempts);
          if (state.state === HALF_OPEN) {
            if (probeCount(state) >= config.breaker.probeConcurrency)
              throw breakerError(name, attempts);
            execution.probe = true;
            execution.generation = state.generation;
            addProbe(state, state.generation);
          }
        }
      } finally {
        if (execution.held) {
          execution.held = false;
          releaseSlot(state, execution);
        }
      }
    },

    snapshot() {
      const snapshotUpstreams = {};
      for (const state of upstreams.values()) {
        refreshState(state);
        snapshotUpstreams[state.name] = {
          state: state.state,
          inFlight: state.inFlight,
          queued: state.queue.length,
        };
      }
      return { upstreams: snapshotUpstreams, counters: counters.snapshot() };
    },
  };
}
