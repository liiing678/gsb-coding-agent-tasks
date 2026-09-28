# burstgate

多租户限流与配额：每个租户一道令牌桶、一道滑动窗口，还可以共用一个池子，
被拒的时候要告诉调用方大概等多久。只用 Node 标准库，`node >= 20`。

```
burstgate/
├── lib/
│   ├── gate.js      createGate 本体                             ← 还没实现
│   ├── clock.js     手动时钟 / 系统时钟（引擎只通过它取时间）
│   └── errors.js    GateError 与全部错误码
├── test/            bucket / window / gate 三组用例
├── scripts/demo.mjs
└── package.json     npm test / npm run demo
```

```
npm test        # 18 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 配置长什么样

```js
const gate = createGate({
  clock,
  groups: [{ name: 'pool', window: { sizeMs: 1000, max: 6 } }],   // 共享池在建 gate 的时候配
});
gate.register({
  tenant: 'acme',
  bucket: { capacity: 4, refillPerSec: 2 },   // 令牌桶，可以不给
  window: { sizeMs: 1000, max: 5 },           // 滑动窗口，可以不给
  shared: 'pool',                             // 也可以不挂共享池
});
```

- 租户至少要有一道上限，一道都没有或者字段不合法就报 `ERR_BAD_CONFIG`；
  同一个租户注册两次也是这个错。
- 共享池只能建 gate 的时候配，租户用 `shared` 引用一个配过的名字，引用不存在的名字报错。

### 一次请求怎么判

判定顺序是固定的：**租户桶 → 租户窗口 → 共享池的桶 → 共享池的窗口**，每一道都要过。

- 全过：`allowed: true`、`reason: 'ok'`、`retryAfterMs: 0`，然后才真的扣额度。
- 没过：`allowed: false`，`reason` 是第一道挡住的限制（`bucket` / `window` / `shared`），
  `blockedBy` 里列着所有没过的限制，`retryAfterMs` 是**所有没过的那几道里最短的等待时长** —— 等这么久再来，
  同样的一笔就能过；要是怎么等都过不了（比如窗口上限比 cost 还小），就是 `null`。
- `remaining` 里是判定之后还剩多少：`bucketTokens` / `windowRemaining` / `sharedRemaining`，
  没配那道上限就是 `null`。拒绝的时候给的是"现在还剩多少"，不是扣完之后的数。
- 一次要的 `cost` 必须是正整数；超过任何一道配好的上限（桶容量、窗口上限）就是 `ERR_COST_TOO_LARGE`，
  因为这种请求等多久都没用。
- 任何一道不过，谁都别扣：判定和扣额度是分开的，被拒的请求不能把桶里的令牌顺手吃掉。

### 令牌桶

- 初始是满桶，按毫秒线性补：`tokens += 经过的毫秒 / 1000 * refillPerSec`，补到 `capacity` 为止。
- 令牌保留 6 位小数（`Math.round(x * 1e6) / 1e6`），免得浮点尾巴让判定飘。
- 够 `cost` 才过，不够就按缺的令牌数算等待时间：`ceil(缺额 / refillPerSec * 1000)` 毫秒。

### 滑动窗口

- 记下每次通过的 `{ at, cost }`。判定的时候只看 `at - now < sizeMs` 的那些记录，
  相加不超过 `max` 才过。正好隔了 `sizeMs` 的记录算滚出去了。
- 不是整段重置：每条记录自己过期，所以窗口里是"最近 sizeMs 里的消耗"。
- 被拒时等待时间是**最早那条记录滚出去**的时间（`最早一条的 at + sizeMs - now`），
  不够就接着往后算，直到把缺的额度腾出来。

### 时间

引擎不直接读 `Date.now()`，只通过传进来的 `clock`。**时钟往回拨的时候**（NTP 校时、容器
迁移都可能发生）按"上一次见过的时间"算：不回补令牌、也不把窗口记录丢掉，返回结果里的 `at`
就是实际用的那个时间。也就是说回拨不能白拿额度。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_UNKNOWN_TENANT` | 这个租户没配过（`check` / `checkMany` / `stats`） |
| `ERR_BAD_CONFIG` | 配置不合法：重复注册、没有上限、共享池没配过、字段取值不对、`checkMany` 空数组 |
| `ERR_COST_TOO_LARGE` | `cost` 不是正整数，或者比某一道上限还大 |
| `ERR_BAD_SNAPSHOT` | 快照版本不认识 |

## API

```js
import { createGate } from './lib/gate.js';
```

### `createGate({ clock, groups })`

`clock` 不传就用系统时钟；`groups` 是共享池数组。

### `register({ tenant, bucket?, window?, shared? })`

返回 `{ tenant, shared, limits: { bucket, window } }`（`limits` 是布尔，表示配没配）。

### `check(tenant, cost = 1)`

返回：

```js
{
  allowed: false,
  tenant: 'acme',
  cost: 1,
  at: 850,              // 这次判定用的时间
  reason: 'bucket',     // ok / bucket / window / shared
  blockedBy: ['租户桶'],
  retryAfterMs: 160,
  remaining: { bucketTokens: 0.68, windowRemaining: 0, sharedRemaining: 0 },
}
```

### `checkMany([{ tenant, cost }, ...])`

同一时刻的一批请求，**顺序判定、逐个累加**（同一个租户出现好几次也要互相看得见），
只要有一笔不过就整批回滚、一个字节的额度都不扣。返回
`{ allowed, results: [每个请求的判定结果] }`；其中 `allowed` 是整批的结论。

### `stats(tenant?)`

不带租户名返回 `{ allowed, denied, byReason: { bucket, window, shared }, tenants, groups, perTenant }`；
带租户名再多一个 `tenant`，形状是 `{ tenant, shared, bucket: { tokens, capacity }, window: { sizeMs, max, used } }`。

### `snapshot()` / `restore(state)`

快照是个能 `JSON.stringify` 的普通对象（带每个桶的令牌、窗口里的记录、计数器和 `lastSeen`），
`restore` 之后限流接着走，桶和窗口都不会重置。版本不对报 `ERR_BAD_SNAPSHOT`。

## demo 跑出来应该长这样

`npm run demo` 用的是手动时钟，输出每一行都能对上：

```
burstgate demo
[1] acme 的桶是 4 个，窗口 1 秒 5 个
    第 1 次: allowed=true reason=ok retryAfterMs=0 bucket=3 window=4 shared=5
    第 2 次: allowed=true reason=ok retryAfterMs=0 bucket=2.02 window=3 shared=4
    第 3 次: allowed=true reason=ok retryAfterMs=0 bucket=1.04 window=2 shared=3
    第 4 次: allowed=true reason=ok retryAfterMs=0 bucket=0.06 window=1 shared=2
    第 5 次: allowed=false reason=bucket retryAfterMs=460 bucket=0.08 window=0 shared=1
[2] 等 500 毫秒，桶补回来一点
    再来: allowed=true reason=ok retryAfterMs=0 bucket=0.08 window=0 shared=1
[3] 共享池一共 6 个，globex 用超额了
    globex 第 1 次: allowed=true reason=ok retryAfterMs=0 bucket=null window=4 shared=0
    globex 第 2 次: allowed=false reason=shared retryAfterMs=260 bucket=null window=3 shared=0
    globex 第 3 次: allowed=false reason=shared retryAfterMs=160 bucket=null window=3 shared=0
[4] 时钟被 NTP 往回拨了 5 秒，不能因此白拿额度
    回拨后: allowed=false reason=bucket retryAfterMs=160 bucket=0.68 window=0 shared=0
    at 停在 850 没退回去，令牌 0.68 -> 0.68，窗口里已经用掉的 5 也没被清掉
[5] 换一个进程接着限
    restore -> {"tenants":2,"groups":1}
    接着 acme: allowed=false reason=bucket retryAfterMs=160 bucket=0.68 window=0 shared=0
    stats allowed=6 denied=5
```
