# cachegate 起始环境

订单中台抽出来的服务端读缓存层。**要写的那块是空的**：`src/cache.js` 里的 `createCache`
现在只会抛 `NotImplementedError`，其余是骨架、口径和用例。

## 怎么跑

不用 `npm install`，这个仓库没有任何第三方依赖，`package.json` 里也不要加 `dependencies`。

```
npm test                                 # node --test 跑 test/cachegate.test.js
node bin/cachedemo.js --config configs/dev.json
```

演示不需要任何外部服务：`bin/cachedemo.js` 自己起一个本地假 origin（回源慢、会数回源次数），
跑两段——同一个 key 并发打 200 次，以及"回源途中被失效"。

```
[1] 并发 200 次同一个 key
    回源次数=1
    200 次拿到的值一样吗 -> true
    值={"key":"product:7","name":"保温杯-v1","v":1}

[2] 回源途中失效 category:9
    这次 get 拿到 -> {"key":"product:9","name":"保温杯-v1","v":1}
    写回缓存了吗 -> 没有（被栅栏拦下）
    失效之后再 get -> {"key":"product:9","name":"保温杯-v2","v":2}

-- counters --
cache_gets_total=202
cache_hits_total=0
cache_misses_total=202
cache_loads_total=3
cache_load_errors_total=0
cache_invalidations_total=1
cache_fenced_writes_total=1
cache_degraded_total=0
```

## 目录

| 路径 | 说明 |
|---|---|
| `src/cache.js` | **要你写的部分**：`createCache({...})` 返回 `{ get(key), invalidateTag(tag), stats() }` |
| `src/shared-store.js` | 共享存储（线上是 Redis），命令语义见下（已实现，别改） |
| `src/loader.js` | 我们平时用的回源实现：打 origin 的 HTTP（已实现，别改；测试会换成假的） |
| `src/errors.js` | `StoreDownError` / `CacheUnavailableError` / `NotImplementedError`（已实现，别改） |
| `src/counters.js` | 计数器（已实现，别改） |
| `src/config.js` | 读配置、校验（已实现，别改） |
| `bin/cachedemo.js` | 演示入口：起假 origin，跑上面那两段 |
| `test/cachegate.test.js` | 用例，现在跑是红的 |
| `test/support/` | 假时钟、可控的假 loader、搭 cache 的小工具 |
| `configs/dev.json` | 演示和默认配置 |

## 接口

```js
createCache({
  config,     // configs/dev.json 里 cache 那一段（config.js 已经校验过）
  counters,   // src/counters.js
  store,      // 共享存储；多个实例传同一个 store 就是"多实例共享一份 Redis"
  loader,     // 回源函数
  now,        // 取当前时间，默认 () => Date.now()
  sleep,      // 睡 ms 毫秒，默认 setTimeout；测试会换成假时钟
}) -> { get(key, options), invalidateTag(tag), stats() }
```

`get(key, { tags })` 里的 `tags` 是这个 key 关联的标签，比如
`get('product:9', { tags: ['category:9'] })`；我们所有调用点都会带上它（不带就按没有标签算）。

`loader(key)` 的返回值：

```js
{ found: true, value, ttlMs: 60000 }   // ttlMs 不给就用 config.defaultTtlMs
{ found: false }                       // 这个 key 确实没有，不是错误
```

回源失败就抛错（`src/loader.js` 里 origin 回了 5xx 就抛 `Error`）。`value` 要能 JSON 编码。

命中就返回 `value`；loader 说 `found: false` 时返回 `null`；回源抛错就把错误抛出去。

`stats()` 返回 `{ counters: <counters.snapshot()>, inflight: <本实例正在回源的 key 数> }`。

## 共享存储里的 key

线上运维要按前缀看监控，所以这三类 key 的名字定死了，别改：

| key | 存什么 |
|---|---|
| `cache:<key>` | 缓存条目，值是 JSON 字符串 |
| `cache:gen:<tag>` | tag 的世代号，只增不减 |
| `cache:lock:<key>` | 这个 key 的回源锁 |

## 共享存储的命令（src/shared-store.js，已实现，别改）

全部是异步的（真实环境每次都要走网络）。标了"原子"的一律当成一条 Redis 命令：
并发调它不会互相插进来，也不会出现"读到的值和我写下去之间被别人改掉"。

| 方法 | 说明 |
|---|---|
| `get(key)` | 读，不存在或者已经过期就返回 `null` |
| `set(key, value, ttlMs)` | 写，`ttlMs` 不给就不过期 |
| `del(key)` | 删 |
| `setIfAbsent(key, value, ttlMs)` | **原子**：key 不存在才写，返回有没有写进去（线上是 `SET NX PX`） |
| `compareAndSet(key, expected, next, ttlMs)` | **原子**：当前值严格等于 `expected` 才写 |
| `compareAndDel(key, expected)` | **原子**：当前值严格等于 `expected` 才删 |
| `incr(key, by)` | **原子**自增，返回新值（没这个 key 时从 0 开始） |

值一律是字符串，缓存条目自己 JSON 编解码。`store.setDown(true)` 是给测试和演示用的开关
（模拟共享存储抖掉），实现里别用。

## 配置字段

| 字段 | 说明 |
|---|---|
| `cache.defaultTtlMs` | 条目 TTL，loader 没给 `ttlMs` 时用它 |
| `cache.negativeTtlMs` | 负缓存的 TTL |
| `cache.lockTtlMs` | 回源锁的 TTL，持锁者挂了也能自动放掉 |
| `cache.lockRetryMs` | 抢不到锁时，隔多久回去重读一次缓存 |
| `cache.lockWaitMs` | 等待者最多等这么久 |
| `cache.failMode` | `fail_open` 或 `fail_fast`，共享存储不可用时怎么办 |

## 口径

### 命中判定

条目存在、没过期，**并且**条目里记着的每个 tag 世代号跟共享存储里现在的一致，才算命中；
否则算未命中，该重新回源就重新回源。别人在你读之前改了 tag，你不能还命中旧值。

没失效过的 tag 是没有世代号的（`store.get('cache:gen:<tag>')` 是 `null`），这时候条目里
记的也应该是 `null`，两边照样要能对上。

### 防击穿

- 同一个实例里，同一个 key 的并发 `get` 只允许真回源一次，等待者拿到同一次结果
  （值或者错误）。
- 跨实例靠共享存储上的锁：抢锁用 `setIfAbsent('cache:lock:<key>')`，TTL 用 `lockTtlMs`；
  抢不到就按 `lockRetryMs` 退避回去重读缓存（别人可能已经写好了）。
- 等待超过 `lockWaitMs` 还没拿到结果，就自己抢一次锁；还是抢不到就直接回源——
  宁可多打一次 origin，也不能把请求无限期挂在那儿。
- 锁的 TTL 到点必须能被别人接手，不能把 key 永久锁死。
- 释放锁要带着自己的 token 用 `compareAndDel` 删，**不能把别人正在用的锁删掉**：
  你这次回源跑得太久、锁早就过期给别人了，这时候你回来一通 `del`，别人就白锁了。
- 回源成不成，自己那把锁都要放掉。
- 锁的 token 要能区分开实例：本地内存里那个自增序号两个实例会撞成一个值，
  用共享存储的 `incr` 换一个全局序号最省事（key 自己起一个就行）。

### 回源过程中被失效

回源**之前**就要把这次 `get` 带的 tags 的世代取下来，作为这次回源的快照；回源结束后，
快照里任何一个 tag 的世代变了，这条结果就**不许再写回去**（计一次
`cache_fenced_writes_total`），但这次调用照样把它拿到的值返回给调用方。

写进条目的 tag 世代必须是**回源开始前**那份快照里的值。回源跑完才去读一遍世代、把新世代
盖在旧数据上，是最典型的错法：读者会因为"世代对得上"而一直命中这个旧值，直到 TTL 过去。

### 负缓存

loader 说 `found: false` 的时候写一条负缓存，TTL 是 `negativeTtlMs`，这期间 `get` 直接返回
`null`，不要每次都去戳 origin。负缓存也要能被 `InvalidateTag` 失效掉。

回源**抛错**的时候什么都不写（负缓存也不写），错误原样抛给这次 `get`；
同一批等待者拿到的是同一个错误。

回源已经成功、只是写缓存这一步失败（共享存储又抖了）的时候，这次 `get` 照常把值返回，
别把好好的一个请求搞成 5xx；这种时候计一次 `cache_degraded_total` 就行。

### 失效

`invalidateTag(tag)` 返回之后，任何实例都不许再命中失效之前的旧值。世代号只能往上走：
两个实例同时失效同一个 tag、同一个 tag 连着失效好几次，都不能把世代号改回去
（所以别用读出来加一再写回去的写法）。

### 共享存储不可用时

共享存储抛 `StoreDownError` 时按 `failMode` 走：

- `fail_open`：跳过共享存储，直接回源，返回结果（不写缓存），计 `cache_degraded_total`。
- `fail_fast`：抛 `CacheUnavailableError`。

只有共享存储的错才走降级；回源自己抛的错照常往上抛。

### 计数器

名字固定，别改名、也别加新的：

| 名字 | 什么时候加 |
|---|---|
| `cache_gets_total` | 每次 `get()` 进来加一 |
| `cache_hits_total` | 命中 |
| `cache_misses_total` | 没命中（包括条目过期、tag 世代对不上） |
| `cache_loads_total` | 真回源一次（抢到锁的那次、降级直连的那次都算） |
| `cache_load_errors_total` | 回源抛错的次数 |
| `cache_invalidations_total` | 每次 `invalidateTag()` 加一 |
| `cache_fenced_writes_total` | 回源结果因为失效栅栏被丢掉、没写回去 |
| `cache_degraded_total` | 因为共享存储不可用走了降级 |

## 自检

`npm test` 全绿就算过关，`test/cachegate.test.js` 里每条用例的注释写了它在验什么。

`configs/dev.json` 和 `test/` 下的用例是评测用的，不要改、不要补、不要删。
