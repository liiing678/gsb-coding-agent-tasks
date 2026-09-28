// 错误类型：这部分已经定好了，别改。

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

// 池已经关了（或者正在关）：acquire 不收。
export class PoolClosedError extends Error {
  constructor(message = 'pool is closed') {
    super(message);
    this.name = 'PoolClosedError';
    this.code = 'pool_closed';
  }
}

// 排队等太久了。
export class AcquireTimeoutError extends Error {
  constructor(message = 'acquire timed out') {
    super(message);
    this.name = 'AcquireTimeoutError';
    this.code = 'acquire_timeout';
  }
}

// 等待队列满了，直接拒。
export class PoolExhaustedError extends Error {
  constructor(message = 'wait queue is full') {
    super(message);
    this.name = 'PoolExhaustedError';
    this.code = 'pool_exhausted';
  }
}
