// 这个文件就是要写的那块。现在它只会抛 NotImplementedError。
//
// createGuard({ config, counters, transport, now, sleep, random }) -> { call(request), snapshot() }
//   config    : configs/dev.json 里 egress 那一段（config.js 已经校验过），字段见 README
//   counters  : src/counters.js 的计数器，名字见 README
//   transport : 真正发请求的函数，默认 src/upstream.js 的 send；测试会换成假上游
//   now       : 取当前时间，默认 () => Date.now()
//   sleep     : 睡 ms 毫秒，默认 setTimeout；测试会换成假时钟
//   random    : 0..1 的随机数，默认 Math.random，只给退避抖动用
//
// 单次尝试的超时是 transport 自己的事（src/upstream.js 用 AbortSignal 做），这里把这次
// 尝试能用的时间算好交给它就行，不要再自己套一层计时器。
//
// call(request) / snapshot() 的语义见 README 的《接口》和《口径》。

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export function createGuard({
  config,
  counters,
  transport,
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
  return {
    async call() {
      throw new NotImplementedError('createGuard 还没有实现');
    },
    snapshot() {
      throw new NotImplementedError('createGuard 还没有实现');
    },
  };
}
