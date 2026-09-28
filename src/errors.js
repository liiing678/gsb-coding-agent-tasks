// 错误分类和错误对象：这部分已经定好了，别改。

export const ErrorKind = {
  CONNECT: 'connect', // 连不上
  TIMEOUT: 'timeout', // 这次尝试超时
  STATUS: 'status', // 上游回了响应，但状态码是失败的
  BUDGET: 'budget', // 预算不够，根本没发出去
  BREAKER: 'breaker', // 熔断挡下的
  QUEUE: 'queue', // 并发满了，队列也排不下
};

export const Reason = {
  MAX_ATTEMPTS: 'max_attempts',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  RETRY_AFTER_EXHAUSTED: 'retry_after_exhausted',
  BREAKER_OPEN: 'breaker_open',
  QUEUE_FULL: 'queue_full',
  NON_RETRYABLE: 'non_retryable',
};

export class EgressError extends Error {
  constructor(kind, message, { status = 0, reason = '', upstream = '', attempts = 0, cause } = {}) {
    super(message);
    this.name = 'EgressError';
    this.kind = kind;
    this.reason = reason;
    this.status = status;
    this.upstream = upstream;
    this.attempts = attempts;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// 这个状态码算不算"这次尝试失败了"。注意它只回答"算不算失败"，
// 至于值不值得再试一次，是另一回事（见 README 的《重试》）。
export function isFailureStatus(status) {
  return status === 429 || status >= 500;
}
