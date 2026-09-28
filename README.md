# connlease 起始环境

连下游用的连接池：借出、归还、排队、租约回收、坏连接销毁、关池。
**要写的那块是空的**：`src/pool.js` 里的 `createPool` 现在只会抛 `NotImplementedError`，
其余是骨架、口径和用例。

## 怎么跑

不用 `npm install`，这个仓库没有任何第三方依赖，`package.json` 里也不要加 `dependencies`。

```
npm test                                 # node --test test/connlease.test.js
npm run demo                             # node bin/demo.js --config configs/dev.json
```

演示不需要任何外部服务：`bin/demo.js` 自己起一个本地 TCP 下游（`bin/mock-downstream.js`），
用 `src/tcpdriver.js` 连上去，然后拿池子跑五个场景。

## 目录

| 路径 | 说明 |
|---|---|
| `src/pool.js` | **要你写的部分**：`createPool({...})` 返回 `{ acquire, stats, close }` |
| `src/tcpdriver.js` | 真连下游的驱动（已实现，别改） |
| `src/config.js` | 读配置、校验（已实现，别改） |
| `src/counters.js` | 计数器（已实现，别改） |
| `src/errors.js` | `PoolClosedError` / `AcquireTimeoutError` / `PoolExhaustedError`（已实现，别改） |
| `bin/demo.js` | 演示入口 |
| `bin/mock-downstream.js` | 演示用的本地下游：一行请求一行响应，`PING` 回 `PONG` |
| `test/connlease.test.js` | 用例，现在跑是红的 |
| `test/support/` | 假时钟、假驱动 |
| `configs/dev.json` | 演示和默认配置 |

## 接口

```js
createPool({
  config,    // configs/dev.json 里 connlease 那一段（config.js 已经校验过）
  driver,    // 见下
  counters,  // src/counters.js
  now,       // 取当前时间，默认 () => Date.now()
  sleep,     // 等 ms 毫秒，默认 setTimeout；测试会换成假时钟
}) -> { acquire(), stats(), close() }
```

driver 的形状：

```js
{
  open(): Promise<conn>,      // 建一条新连接；失败就 reject
  close(conn): Promise<void>, // 关掉这条连接
  isBroken(conn): boolean,    // 这条连接是不是已经废了（同步判断）
}
```

`conn` 是什么由驱动决定，池子只要求它能在 `Map` / `Set` 里当 key 用。池子不碰连接上的业务，
拿到 `conn` 之后怎么用是调用方的事。

- `acquire()`：返回 Promise，resolve 出来的是这次借出的租约：
  `{ id, conn, release(options) }`。
  - `id` 是这次借出的编号，从 1 开始，每借出一次加一。
  - `release({ broken = false } = {})`：还连接。`broken: true` 表示这条连接用废了。
  - 同一条租约重复 `release()` 是幂等的，不报错，也不重复计数。
- `stats()`：同步返回
  `{ live, idle, borrowed, creating, waiters, counters }`。
  - `live`：已经建好、还没关掉的连接数（借出的 + 空闲的）
  - `idle` / `borrowed`：空闲的、借出去的
  - `creating`：正在建立中的连接数
  - `waiters`：正在排队的调用方数量
  - `counters`：`counters.snapshot()`
- `close()`：返回 Promise。语义见下。

## 口径

### 连接上限

- 池子里"已经建好的 + 正在建"的连接数，任何时候都不能超过 `config.maxConnections`。
  `open()` 是异步的，从调用 `open()` 到它 resolve 这段时间，这条连接的额度就已经被占掉了。
- 借出优先用空闲连接；空闲的没有、额度又没满，才建新的。
- 建新连接失败（`open()` reject）：把额度还回去，并把 `acquire()` 那个 promise reject 掉。

### 排队

- 额度满了才排队，先来的先拿到连接（FIFO），不许插队。
- 排队超过 `config.acquireTimeoutMs` 还没拿到，就抛 `AcquireTimeoutError`，并且要从队列里摘干净：
  这个已经放弃的调用方不能继续占着位置，也不能在之后拿到连接。
- 队列长度上限是 `config.maxWaiters`；已经排了这么多还要再排，直接抛 `PoolExhaustedError`。
- 有连接空出来（还回来、或者新建成）的时候，排队的人要立刻被安排上。

### 租约与回收

- 一条连接借出去超过 `config.leaseTimeoutMs` 还没还，就当归调用方忘了还：
  这条连接销毁掉（`connlease_broken_total` 和 `connlease_lease_expired_total` 各计一笔），
  排队的调用方可以顶上一条新的。
- 回收得认租约：一条连接还回来之后又借给了别人，上一次那张旧租约到点不能把这会儿正在用的连接收走。
  `now()` 和 `sleep()` 都从外面注入，回收是池子自己定时扫，不是调用方触发。

### 坏连接

- `release({ broken: true })`、或者还回来的时候 `driver.isBroken(conn)` 已经是 true：销毁这条连接。
- 空闲连接在借出去之前要再问一次 `driver.isBroken(conn)`，坏了的直接销毁换一条，不能借给调用方。
- 销毁连接要走 `driver.close(conn)`；关不掉的连接不要卡住池子。

### 关池

- `close()` 之后不再接新的 `acquire()`：当时还没拿到连接的排队者全部被 `PoolClosedError` 拒掉，
  之后再来的 `acquire()` 也直接 `PoolClosedError`。
- 空闲连接立刻关掉；已经借出去的连接不打断，等它还回来的时候关掉（或者租约到点被回收）。
- 所有连接都关完了，`close()` 的那个 promise 才 resolve；重复调用 `close()` 返回同一个 promise。

### 计数器

名字固定，别改名、也别加新的：

| 名字 | 什么时候加 |
|---|---|
| `connlease_acquire_total` | 每次调 `acquire()` 就加一（不管最后成没成） |
| `connlease_borrowed_total` | 真正借出去一次加一 |
| `connlease_created_total` | `driver.open()` 成功建出一条连接加一 |
| `connlease_waited_total` | 进等待队列加一 |
| `connlease_wait_timeout_total` | 排队超时加一 |
| `connlease_rejected_total` | 队列满了被直接拒加一 |
| `connlease_returned_total` | 成功归还一次加一（`broken: true` 的也算归还） |
| `connlease_broken_total` | 判定为坏连接并销毁加一（含租约到点回收的） |
| `connlease_lease_expired_total` | 租约到点回收加一 |

## 演示输出

`npm run demo` 现在跑不起来（池子还没写）。写完之后的输出是这样：

```
[1] 串行借还 5 次
    第一次拿到 conn-1，下游回 PONG
    池子 live=1 idle=1 borrowed=0
    下游一共 accept 了 1 条连接
[2] 同时来 6 个请求，上限是 4
    借出 4，排队 2
    还一条出去，排第一个的借到 conn-1
    再还一条，排第二个的借到 conn-2
    全还完：live=4 idle=4
[3] 借出去忘了还，等租约自己到期
    借出 conn-1，300ms 之内没人还
    租约到期回收 1 条，现在 live=3
[4] 还回来的时候说这条连接坏了
    conn-2 被销毁，下一次借到 conn-3
[5] 关池
    关了之后再借 -> pool_closed

-- counters --
connlease_acquire_total=15
connlease_borrowed_total=14
connlease_created_total=4
connlease_waited_total=2
connlease_wait_timeout_total=0
connlease_rejected_total=0
connlease_returned_total=13
connlease_broken_total=2
connlease_lease_expired_total=1
```

## 自检

`npm test` 全绿就算过关，`test/connlease.test.js` 里每条用例的注释写了它在验什么。

`configs/dev.json`、`test/` 下的用例是评测用的，不要改、不要补、不要删。
