# idemgate 起始环境

写接口外面那层幂等。**要写的那块是空的**：`src/idempotency.js` 里的 `createIdempotency`
现在只是抛 `NotImplementedError`，其余是骨架、口径和用例。

## 怎么跑

不用 `npm install`，这个仓库没有任何第三方依赖，`package.json` 里也不要加 `dependencies`。

```
npm test                                      # node --test 跑 test/ 下的用例
node src/server.js --config configs/dev.json  # 起服务（默认读 configs/dev.json）
```

起了服务之后，`/write` 是个演示用的写接口（自己等 50 毫秒、每次返回一个新的序号），
真正要写的是它外面那层：

```
curl -s -XPOST -H "Idempotency-Key: demo-1" -d '{"a":1}' http://127.0.0.1:8080/write
curl -s -XPOST -H "Idempotency-Key: demo-1" -d '{"a":1}' http://127.0.0.1:8080/write
curl -s -XPOST -H "Idempotency-Key: demo-1" -d '{"a":2}' http://127.0.0.1:8080/write
curl -s http://127.0.0.1:8080/_metrics
```

第二条应该拿到跟第一条一模一样的结果，只是多一个 `x-idem-replay: true`；
第三条是同一个 key 换了 body，应该回 409。

## 目录

| 路径 | 说明 |
|---|---|
| `src/server.js` | HTTP 入口：读请求体、认 `/_metrics`、把请求交给幂等层 |
| `src/config.js` | 读配置、校验字段 |
| `src/metrics.js` | 计数器 |
| `src/recorder.js` | 响应录制器：handler 往里写状态码、响应头和 body |
| `src/idempotency.js` | **要你写的部分**，`createIdempotency({ config, metrics, now })` 返回 `{ handle(ctx) }` |
| `test/idempotency.test.js` | 用例，现在跑是红的 |
| `test/support/` | 假时钟、阻塞用的 deferred、起服务的小工具 |
| `configs/dev.json` | 本地开发用的配置 |

`handle(ctx)` 的 `ctx` 是 `{ req, res, body, handler }`：`req` / `res` 是 node 的请求和响应对象，
`body` 是已经读完的请求体（Buffer），`handler(req, recorder)` 是业务处理函数——它把状态码、响应头
和 body 写进 `recorder`（`src/recorder.js`，已实现），什么时候写回客户端由幂等层决定。

## 配置字段

| 字段 | 说明 |
|---|---|
| `listen.host` / `listen.port` | 监听地址，端口给 0 表示随机 |
| `idempotency.ttlMs` | 结果在缓存里留多久（毫秒） |
| `idempotency.maxEntries` | 缓存条目上限 |
| `idempotency.maxWaiters` | 挂在同一个在飞执行上的等待者上限 |
| `idempotency.maxKeyBytes` | `Idempotency-Key` 的长度上限（字节） |

## 幂等口径

### 什么时候走幂等

- 请求头 `Idempotency-Key` 缺失或者是空串：不看也不缓存，直接交给 handler，
  计 `idem_passthrough_total`。
- key 比 `maxKeyBytes` 长：不执行 handler，回 `400`，响应体 `{"error":"invalid_idempotency_key"}`，
  计 `idem_rejected_total`。
- 其它情况都是幂等请求，先计 `idem_requests_total`。

### 指纹

指纹 = `method` + `url`（原始的 path 和 query，不做归一化）+ 请求体 `sha256` 的十六进制。
一个 key 只能对应一个指纹：

- 指纹一样，才算"同一件事"；
- 指纹不一样：不执行 handler，回 `409`，响应体 `{"error":"idempotency_key_reuse"}`，
  计 `idem_conflicts_total`。**不管这个 key 有没有在飞、有没有缓存，都当场 409**，
  不能挂上去等，更不能把别人的结果回给他。

### 同一件事（同 key 同指纹）

- 没有在飞、也没有能用的缓存：执行一次 handler，计 `idem_executed_total`，把这次的结果
  （状态码 + 白名单响应头 + body）缓存 `ttlMs`，再回给客户端。
- 有在飞（上一次还没跑完）：挂上去等这一次的结果，计 `idem_waited_total`，不要自己再执行一遍。
  等待者拿到的一定是跟发起者同一份结果，包括失败的状态码。
- 有缓存且没过期：直接回放，计 `idem_replayed_total`，不执行 handler，
  回放时带 `x-idem-replay: true`。
- 缓存过了期就不能再回放，同键同指纹再进来要重新执行一遍。

### 结果

- 缓存和回放的内容：handler 给出的状态码、白名单里的响应头、body。白名单是
  `content-type`、`cache-control`、`location`、`etag`，别的响应头（`set-cookie`、`date`、
  hop-by-hop 那些）一律不带。回放时 `content-length` 按缓存下来的 body 重算。
- handler 抛错，或者根本没调用 `recorder.end()`：这次执行算失败。发起者和所有等待者都拿到
  `500`，响应体 `{"error":"handler_failed"}`；这次结果**不进缓存**，后面同键同指纹的请求会重新执行。
- 客户端断开（结果还没写回之前 `res` 就关掉了）：这次执行不要中断，等待者还在等着；
  结果照常缓存，只是写回失败，计 `idem_aborted_total`。

### 上限

- 缓存条目到 `maxEntries`：淘汰最久没用过的条目（在飞的不算），计 `idem_evicted_total`；
  回放一次也算"用过"。被淘汰掉的键后面再进来就重新执行。
- 挂在同一个在飞执行上的等待者到 `maxWaiters`：再来的同键请求不排队，回 `503`，
  响应体 `{"error":"too_many_waiters"}`，计 `idem_rejected_total`。

## 计数器

`metrics.snapshot()` 里能读到的名字就这些，别改名、也别再发明别的：

| 名字 | 什么时候加 |
|---|---|
| `idem_requests_total` | 每个带非空 key 的请求加一（含后面被拒的那些） |
| `idem_passthrough_total` | 没有 key、直接透传的请求 |
| `idem_executed_total` | 真的执行了 handler 的次数 |
| `idem_replayed_total` | 用缓存结果回放的次数 |
| `idem_waited_total` | 挂到别人的在飞执行上等待的次数 |
| `idem_conflicts_total` | 同键不同指纹被拒的次数 |
| `idem_evicted_total` | 被上限淘汰掉的缓存条目数 |
| `idem_aborted_total` | 客户端断开导致写回失败的次数 |
| `idem_rejected_total` | 其它被拒的请求（key 太长、等待者太多） |

## 自检

`npm test` 全绿就算过关。`test/idempotency.test.js` 里每条用例的注释写了它在验什么。

`configs/dev.json` 和 `test/` 里的用例是评测用的，不要改、不要补、不要删。
