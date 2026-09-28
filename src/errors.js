// 错误类型：这部分已经定好了，别改。

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

// 网关正在关闭：新的订阅、新的发布都不收。
export class ClosingError extends Error {
  constructor(message = 'hub is closing') {
    super(message);
    this.name = 'ClosingError';
    this.code = 'closing';
  }
}

// 订阅数到 maxSubscriptions 了。
export class SubscriberLimitError extends Error {
  constructor(message = 'too many subscribers') {
    super(message);
    this.name = 'SubscriberLimitError';
    this.code = 'too_many_subscribers';
  }
}
