// 错误类型：这部分已经定好了，别改。

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

// 共享存储（线上是 Redis）连不上/超时的时候，src/shared-store.js 抛这个。
export class StoreDownError extends Error {
  constructor(message = 'shared store is down') {
    super(message);
    this.name = 'StoreDownError';
    this.code = 'store_down';
  }
}

// failMode = fail_fast 时，共享存储不可用就直接抛这个。
export class CacheUnavailableError extends Error {
  constructor(message = 'cache backend unavailable') {
    super(message);
    this.name = 'CacheUnavailableError';
    this.code = 'cache_unavailable';
  }
}
