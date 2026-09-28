// 这个文件就是要写的那块。现在它只会抛 NotImplementedError。
//
// createIdempotency({ config, metrics, now }) -> { handle(ctx) }
//   config  : configs/dev.json 里 idempotency 那一段（已经校验过）
//   metrics : src/metrics.js 的计数器，名字见 README
//   now     : 取当前时间的函数，默认 () => Date.now()；测试会塞假时钟
//
// handle({ req, res, body, handler })：语义见 README 的「幂等口径」。
// handler(req, recorder) 把结果写进 src/recorder.js 的录制器，什么时候写回 res 由这里决定。

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export function createIdempotency({ config, metrics, now = () => Date.now() } = {}) {
  return {
    async handle() {
      throw new NotImplementedError('createIdempotency 还没有实现');
    },
  };
}
