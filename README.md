# httpcache

自己实现一层共享 HTTP 缓存：什么时候能存、存下来多久算新、`Vary` 怎么分条目、
过期了能不能先拿旧的顶一下、回源 304 之后怎么续命。只用 Node 标准库，没有第三方包，`node >= 20`。

```
httpcache/
├── lib/
│   ├── httpcache.js  createHttpCache 本体               ← 还没实现
│   └── errors.js     HttpCacheError 与全部错误码
├── test/             freshness / revalidate 两组用例
├── scripts/demo.mjs  手工过一遍的演示脚本
└── package.json      npm test / npm run demo
```

```
npm test        # 18 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 请求与响应

`request` 是 `{ method, url, headers }`，`response` 是 `{ status, headers }`。
头名一律按**小写**比对（传进来的大写会被折成小写）；头的值必须是字符串，否则报错。
`Cache-Control` 按 `,` 切开、名字小写、值去掉两侧引号；`max-age` / `s-maxage` / `age` /
`stale-while-revalidate` 这些要数字的指令，值不是十进制整数就**当没写**。

### 能不能存

`store(request, response)` 按顺序检查，任何一条不过就返回 `{ stored: false, reason }`：

| reason | 什么时候 |
|---|---|
| `method` | 请求方法不是 `GET` / `HEAD` |
| `no-store` | 请求或响应的 `Cache-Control` 里带 `no-store` |
| `private` | 响应的 `Cache-Control` 里带 `private`（这是共享缓存） |
| `authorization` | 请求带 `Authorization`，而响应没有 `public` / `s-maxage` / `must-revalidate` 之一 |
| `status` | 状态码不在可缓存集合里：200 / 203 / 204 / 300 / 301 / 308 / 404 / 405 / 410 / 414 / 501 |
| `vary` | 响应带 `Vary: *` |

都过了就存下来，返回 `{ stored: true, reason: 'stored', key }`，`key` 是 `"<方法> <url>"`。
缓存键是「方法 + URL + `Vary` 指定的那些请求头的值」：`Vary` 里列的头（小写比较），
存的时候什么值、查的时候就得什么值；**头没带就是 `null`**，和带了但不等于原值的不算匹配。
同一条 URL 的不同变体各占一个条目；同一个变体再存一次就覆盖旧的。

### 新鲜度

响应存下来的那一刻记 `storedAt`，新鲜期 `freshnessMs` 按这个顺序算：

1. `s-maxage`（秒）× 1000；
2. 否则 `max-age`（秒）× 1000；
3. 否则 `Expires` 与 `Date` 之差（没有 `Date` 就拿 `storedAt` 顶）；
4. 否则启发式：响应有 `Last-Modified` 和 `Date` 且 `Date > Last-Modified` 时，
   取 `(Date - Last-Modified) * heuristicFraction` 向下取整；
5. 都没有就是 0，也就是一存下来就过期。

查询时的年龄 `ageMs = Age头(秒)×1000 + (now - storedAt)`。
**`ageMs < freshnessMs` 才算新鲜**，正好到点按过期算。

### 查询结果

`lookup(request)` 返回
`{ hit, status, entry, ageMs, freshnessMs, canServeStale, requiresRevalidation }`：

- `hit: false`（没条目、`Vary` 对不上、请求自己带 `no-store`）时是
  `status: 'miss'`，`entry` / `ageMs` / `freshnessMs` 都是 `null`，`requiresRevalidation: true`；
- `status: 'fresh'`：新鲜，可以直接用；
- `status: 'must-revalidate'`：**不许直接用**。出现在三种情况下：响应带 `no-cache`（哪怕还新鲜）、
  请求自己带 `no-cache` 或 `max-age=0`、或者已过期且响应带 `must-revalidate`；
- `status: 'stale'`：过期了，但还允许 stale 复用。
- `canServeStale`：只有 `status === 'stale'`，且响应带 `stale-while-revalidate=N`，
  且 `ageMs < freshnessMs + N×1000` 时才是 `true`；
- `requiresRevalidation = status !== 'fresh' && !canServeStale`。

`entry` 是 `{ status, headers }`（**头是拷贝**，外面改了不影响缓存里那份）。
条目命中会刷新它的「最近使用时间」，超过 `maxEntries` 时按最近使用时间踢掉最久没用的那条。

### 回源

`revalidate(request, response)`：

- 有匹配条目 + 响应是 `304` → 用 304 的头覆盖同名头、`storedAt` 归到这一刻、重算新鲜度，
  返回 `{ action: 'refreshed', key }`；
- 有匹配条目 + 其它响应 → 先删掉旧条目再按 `store` 的规则处理：能存就是
  `{ action: 'replaced', key }`，不能存就是 `{ action: 'evicted', reason }`（旧条目已经没了）；
- 没有匹配条目 + `304` → `{ action: 'ignored', reason: 'no-entry' }`（什么都不动）；
- 没有匹配条目 + 其它响应 → 按 `store` 处理，能存是 `replaced`，不能存是 `evicted`。

只有真的处理了「有旧条目」的情况才算一次 `revalidations`。

`purge({ url })` 把这条 URL 的**所有变体**都删掉，返回 `{ url, removed }`。

`stats()` → `{ entries, stores, hits, misses, revalidations, evictions, staleServed }`：
`hits` / `misses` 按 `lookup` 计数，`staleServed` 是 `lookup` 里 `canServeStale` 为真的次数。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_CONFIG` | `config` 不是对象、`clock` 不是函数或返回非有限数、`maxEntries` 不是正整数、`heuristicFraction` 不在 `[0, 1]` |
| `ERR_BAD_REQUEST` | 请求不是对象、`method` / `url` 不是非空字符串、请求头的值不是字符串、请求头不是对象 |
| `ERR_BAD_RESPONSE` | 响应不是对象、`status` 不是 100..599 的整数、响应头的值不是字符串 |
| `ERR_BAD_ARGS` | `purge` 没给参数对象或 `url` 不是非空字符串 |

## API

```js
import { createHttpCache, DEFAULTS } from './lib/httpcache.js';

let now = Date.parse('2026-01-01T00:00:00Z');
const cache = createHttpCache({ clock: () => now, maxEntries: 100 });

const request = { method: 'GET', url: '/api/list', headers: {} };
cache.store(request, { status: 200, headers: { date: new Date(now).toUTCString(), 'cache-control': 'max-age=60' } });
cache.lookup(request);                       // -> { hit: true, status: 'fresh', ... }
now += 70_000;
cache.lookup(request);                       // -> { hit: true, status: 'stale', requiresRevalidation: true }
cache.revalidate(request, { status: 304, headers: { date: new Date(now).toUTCString() } });
cache.purge({ url: '/api/list' });
cache.stats();
```

出错一律抛 `HttpCacheError`（`lib/errors.js`），按 `code` 分流。

## demo 跑出来应该长这样

`npm run demo` 里时间是写死的，输出每一行都能对上：

```
httpcache demo
[1] 存一份能放 60 秒的响应
    store {"stored":true,"reason":"stored","key":"GET /api/list"}
[2] 30 秒后还是新的
    lookup {"hit":true,"status":"fresh","ageMs":30000,"freshnessMs":60000,"canServeStale":false,"requiresRevalidation":false}
[3] 70 秒后过期，得回源
    lookup {"hit":true,"status":"stale","ageMs":70000,"freshnessMs":60000,"canServeStale":false,"requiresRevalidation":true}
[4] 带 stale-while-revalidate 的还能先顶着用
    lookup {"hit":true,"status":"stale","ageMs":30000,"freshnessMs":10000,"canServeStale":true,"requiresRevalidation":false}
[5] Vary 对不上就不能复用
    lookup {"hit":false,"status":"miss","ageMs":null,"freshnessMs":null,"canServeStale":false,"requiresRevalidation":true}
[6] 回源 304 只把时间刷一遍
    revalidate {"action":"refreshed","key":"GET /api/list"}
    lookup {"hit":true,"status":"fresh","ageMs":0,"freshnessMs":60000,"canServeStale":false,"requiresRevalidation":false}
[7] 统计
    {"entries":3,"stores":3,"hits":4,"misses":1,"revalidations":1,"evictions":0,"staleServed":1}
```
