// 这个文件就是要写的那块。现在它只会抛 NotImplementedError。
//
// createTokenService({ config, metrics, keys, now, random })
//   -> { issue, refresh, verify, revoke, reloadKeys, snapshot }
//
//   config  : configs/dev.json 里 tokens 那一段（已经校验过）
//   metrics : src/metrics.js 的计数器，名字见 README
//   keys    : src/keys.js 归一化过的密钥集合（[{ kid, secret, state, verifyUntilMs }]）
//   now     : 取当前时间的函数，默认 () => Date.now()；测试会塞假时钟
//   random  : 取随机数的函数，默认 Math.random；测试会塞定种子的伪随机
//
// 令牌长什么样、每步的 code、计数器怎么算，README 的「口径」那几节里都写了。

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export function createTokenService({
  config,
  metrics,
  keys,
  now = () => Date.now(),
  random = Math.random,
} = {}) {
  let currentKeys = keys;

  return {
    issue() {
      throw new NotImplementedError('createTokenService().issue 还没有实现');
    },
    refresh() {
      throw new NotImplementedError('createTokenService().refresh 还没有实现');
    },
    verify() {
      throw new NotImplementedError('createTokenService().verify 还没有实现');
    },
    revoke() {
      throw new NotImplementedError('createTokenService().revoke 还没有实现');
    },
    reloadKeys() {
      throw new NotImplementedError('createTokenService().reloadKeys 还没有实现');
    },
    snapshot() {
      throw new NotImplementedError('createTokenService().snapshot 还没有实现');
    },
    get keys() {
      return currentKeys;
    },
  };
}
