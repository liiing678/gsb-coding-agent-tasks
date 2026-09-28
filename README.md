# egressguard 起始环境

服务里做出站调用的那一层。**要写的那块是空的**：`src/guard.js` 里的 `createGuard`
现在只是抛 `NotImplementedError`，其余是骨架、口径和用例。

## 怎么跑

不用 `npm install`，这个仓库没有任何第三方依赖，`package.json` 里也不要加 `dependencies`。

```
npm test                                            # node --test 跑 test/ 下的用例
node bin/egressguard.js --config configs/dev.json   # 起演示：本地起个假上游，打几个调用，打一份 snapshot
```

演示不需要任何外部服务，`bin/egressguard.js` 自己起一个本地假上游：`/quota` 第一次回 503、
第二次回 200，`/profile` 一直回 503，`/geocode` 一直回 429 且带 `Retry-After: 60`。
跑出来应该长这样：

```
[1] quota    ok      status=200 attempts=2
[2] profile  failed  kind=status status=503 attempts=3 reason=max_attempts
[3] profile  failed  kind=breaker attempts=0 reason=breaker_open
    (等 1300ms 冷却)
[4] profile  failed  kind=status status=503 attempts=1 reason=non_retryable
[5] geocode  failed  kind=status status=429 attempts=1 reason=retry_after_exhausted

-- counters --
egress_calls_total=5
egress_attempts_total=7
egress_retries_total=3
egress_budget_exhausted_total=0
egress_retry_after_exhausted_total=1
egress_breaker_rejected_total=1
egress_queue_waited_total=0
egress_queue_full_total=0

-- upstreams --
quota    state=closed inFlight=0 queued=0
profile  state=open inFlight=0 queued=0
geocode  state=closed inFlight=0 queued=0
```

## 目录

| 路径 | 说明 |
|---|---|
| `src/guard.js` | **要你写的部分**：`createGuard({...})` 返回 `{ call(request), snapshot() }` |
| `src/upstream.js` | 真正把请求发出去的那层（已实现，别改）：`send(request, { timeoutMs })` |
| `src/errors.js` | `ErrorKind` / `Reason` / `EgressError` / `isFailureStatus()`（已实现，别改） |
| `src/counters.js` | 计数器（已实现，别改） |
| `src/config.js` | 读配置、校验（已实现，别改） |
| `bin/egressguard.js` | 演示入口：起假上游、打几个调用、打印 snapshot |
| `test/egressguard.test.js` | 用例，现在跑是红的 |
| `test/support/` | 假时钟、假上游、搭 guard 的小工具 |
| `configs/dev.json` | 演示用的配置 |

## 接口

```js
createGuard({
  config,     // configs/dev.json 里 egress 那一段（config.js 已经校验过）
  counters,   // src/counters.js
  transport,  // 默认 src/upstream.js 的 send；测试会换成假上游
  now,        // 取当前时间，默认 () => Date.now()
  sleep,      // 睡 ms 毫秒，默认 setTimeout；测试会换成假时钟
  random,     // 0..1 的随机数，默认 Math.random，只给退避抖动用
}) -> { call(request), snapshot() }
```

`call(request)` 的入参：

```js
{
  upstream: 'quota',       // 上游名，熔断和并发都按它分开算
  method: 'GET',           // 默认 GET
  url: 'http://...',       // 完整 url，调用方给
  headers: {},             // 可选
  body: undefined,         // 可选
  idempotent: false,       // 可选；不给就按 method 判断
  budgetMs: 2000,          // 可选；不给就用 config.budgetMs
}
```

拿到能用的响应就 resolve：

```js
{ status: 200, headers: {...}, body: Buffer, attempts: 2, elapsedMs: 120 }
```

最终失败就 throw `EgressError`：`kind` 是 `ErrorKind` 里的一个，`reason` 是 `Reason` 里的一个，
另外带 `status`（拿得到的话）和 `attempts`。

`transport(request, { timeoutMs })` 的约定（`src/upstream.js` 就是这么实现的）：上游回了响应就
返回 `{ status, headers, body }`——**4xx / 5xx 也是正常返回，不算 transport 的错**；
连不上抛 `EgressError(kind='connect')`；超了 `timeoutMs` 抛 `EgressError(kind='timeout')`。
超时是 transport 自己保证的（真实实现用 `AbortSignal`），guard 只要把这次尝试能用的时间算给它。

## 配置字段

| 字段 | 说明 |
|---|---|
| `egress.budgetMs` | 一次调用的总预算（含所有重试和等待） |
| `egress.attemptTimeoutMs` | 单次尝试的超时 |
| `egress.minAttemptRatio` | 还允许发起下一次尝试的最低剩余预算比例 |
| `egress.maxAttempts` | 一次调用最多发几次尝试 |
| `egress.backoff.baseMs` / `factor` / `maxMs` / `jitterMs` | 退避 |
| `egress.breaker.windowSize` | 熔断窗口：最近多少次真实尝试 |
| `egress.breaker.minSamples` | 至少积累多少个样本才允许打开 |
| `egress.breaker.failureRatio` | 失败比例到多少就打开 |
| `egress.breaker.cooldownMs` | 冷却时长 |
| `egress.breaker.openBackoffFactor` / `cooldownMaxMs` | 冷却随连续打开次数增长的倍率与上限 |
| `egress.breaker.probeConcurrency` | 半开期间同时放几个探测 |
| `egress.breaker.probeSuccesses` | 探测成功几次才算恢复 |
| `egress.bulkhead.maxConcurrency` | 同一个上游同时在飞的上限 |
| `egress.bulkhead.queueLimit` | 同一个上游最多排多少个 |

## 口径

### 一次尝试怎么算

- 上游回了响应：`isFailureStatus(status)` 为真（429、以及 5xx）算这次尝试失败；
  其它（2xx、3xx、401、404 这些）算成功，直接回给调用方——4xx 是上游给的正常答案，
  不是出站层的故障。
- transport 抛 `connect` / `timeout`：算这次尝试失败。
- 失败的尝试里，只有这三种值得再试一次：连接失败、尝试超时、状态码是 429 / 502 / 503 / 504。
  其它失败（500、501 之类）当场失败，`reason='non_retryable'`。
- 非幂等方法（POST / PATCH / PUT / DELETE）默认不重试，`request.idempotent === true` 才重试。
  GET / HEAD / OPTIONS 当幂等看待。
- 尝试次数到 `maxAttempts` 就不再试了，`reason='max_attempts'`。
- 上一次响应带 `Retry-After`（秒数或 HTTP-date 都算）时，等待时长以它为准，不用退避公式；
  带上 `now()` 算，别用真实时间。
- 其它情况等退避：`delay = min(baseMs * factor^(n-1), maxMs) + random() * jitterMs`，
  `n` 是已经发出去的尝试次数。

### 预算

- 一次调用的截止时间是 `start + budgetMs`：尝试、退避、Retry-After 等待、排队等待都在里面。
- 发起下一次尝试前先看剩余预算：少于 `attemptTimeoutMs * minAttemptRatio` 就别发了，
  以 `reason='budget_exhausted'` 失败。
- 每次尝试交给 transport 的超时是 `min(attemptTimeoutMs, 剩余预算)`，绝不越过截止时间。
- 遇到 Retry-After 先算账：等完这段时间还要能再跑一次才值得等；装不下就别等，
  直接以 `reason='retry_after_exhausted'` 失败（这种情况不要产生等待）。
- 排队等的时间同样吃这份预算；轮到它了但剩余预算已经不够，也按 `budget_exhausted` 失败，
  而且一次都不要往上发。

### 熔断（按 upstream 名分开）

- 窗口是最近 `windowSize` 次**真实尝试**的结果：每次真发出去的尝试记一条，按上面《一次尝试怎么算》
  判成功失败。被熔断挡下的、排队满了没排上的、预算不够没发出去的，都不进窗口。
- 窗口里样本数 ≥ `minSamples` 且失败比例 ≥ `failureRatio` → 打开。
- 打开期间不再往上发，直接以 `kind='breaker'` / `reason='breaker_open'` 失败，
  计 `egress_breaker_rejected_total`。
- 打开满 `cooldownMs` 之后进半开：只放 `probeConcurrency` 个探测进去，其它照样按
  `breaker_open` 失败。
- 半开期间探测成功累计到 `probeSuccesses` 次 → 关闭，窗口清空，连续打开次数归零。
- 探测只要挂一次 → 立刻回到打开，这次调用也到此为止（不再重试）；
  冷却时长按连续打开次数翻倍：`cooldownMs * openBackoffFactor^(连续打开次数-1)`，
  封顶 `cooldownMaxMs`。
- 冷却到没到，拿 `now()` 算。

### 并发与排队

- 同一个 upstream 同时在飞的请求不能超过 `maxConcurrency`。
- 满了就排队，先来先得；队列长度到 `queueLimit` 时再来就当场失败：
  `kind='queue'` / `reason='queue_full'`。
- 排上队的计 `egress_queue_waited_total`，被队列顶回去的计 `egress_queue_full_total`。

### 计数器

`counters.snapshot()` 里能读到的名字就这些，别改名、也别加新的：

| 名字 | 什么时候加 |
|---|---|
| `egress_calls_total` | 每次 `call()` 进来加一 |
| `egress_attempts_total` | 真发出去一次尝试加一 |
| `egress_retries_total` | 第二次及以后的每次尝试各加一 |
| `egress_budget_exhausted_total` | 因为预算不够没能再发起尝试（含排队时预算耗光） |
| `egress_retry_after_exhausted_total` | 因为 Retry-After 等不起而放弃 |
| `egress_breaker_rejected_total` | 被熔断挡下的调用 |
| `egress_queue_waited_total` | 进过排队的调用 |
| `egress_queue_full_total` | 队列满了被顶回去的调用 |

### snapshot()

```js
{
  upstreams: {
    quota: { state: 'closed' | 'half-open' | 'open', inFlight: 0, queued: 0 },
    // ...  见过的上游都在这儿
  },
  counters: { /* 跟 counters.snapshot() 一样 */ },
}
```

## 自检

`npm test` 全绿就算过关。`test/egressguard.test.js` 里每条用例的注释写了它在验什么。

`configs/dev.json` 和 `test/` 下的用例是评测用的，不要改、不要补、不要删。
