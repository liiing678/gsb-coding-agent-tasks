# waitgraph

数据库里那套"谁在等谁"的账：事务抢行锁抢不到就排队，资源释放时按 **FIFO** 交接；
一圈人互相等下去就是死锁，得挑一个最年轻的做掉，把它手里的行让给后面排队的人。
只用 Node 标准库，没有第三方包，`node >= 20`。

```
waitgraph/
├── lib/
│   ├── waitgraph.js  createDeadlockDetector 本体        ← 还没实现
│   └── errors.js     WaitError 与全部错误码
├── test/             wait / detect 两组用例
├── scripts/demo.mjs  手工过一遍的演示脚本
└── package.json      npm test / npm run demo
```

```
npm test        # 16 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 事务与资源

- `register({ txId, startedAt })`：登记一个事务。`txId` 不能重复；`startedAt` 不给就用
  `clock()`，它只用来挑死锁受害者（越小越老）。
- `wait({ txId, resource, timeoutMs })`：事务去要某个资源。
  - 资源空着 → 直接拿到，返回 `{ txId, resource, granted: true, waitingFor: null }`；
  - 资源被别人拿着 → 排进**等待队列**（先进先出），返回
    `{ txId, resource, granted: false, waitingFor: <持有者> }`；
  - 一个事务同时只能等一个资源：已经等着了还要等别的 → `ERR_ALREADY_WAITING`；
    去要自己已经拿着的资源 → `ERR_ALREADY_HOLDER`；
  - `timeoutMs` 不给就用 `maxWaitMs`。
- `release({ txId, resource })`：只有持有者能释放。释放后资源**按等待队列的先后**
  交给下一个等待者（那个事务的等待同时清掉），返回里 `grantedTo` 是拿到的人，
  没人排队就是 `null`。

### 死锁检测

`detect()` 是显式调的（`wait` 本身只落边，不会自动杀事务），一次做两件事，
**先处理超时，再看环**：

- 超时：还等着的事务，满足 **`now - waitedAt > timeoutMs`**（严格大于，正好到点不算）
  就算超时，按 `waitedAt` 升序（再按 `txId` 升序）依次作废。
- 环：每个事务最多只有一条等待边（它只等一个资源），所以环互相不相交。找环时从
  字典序最小的 `txId` 开始走；报告出来的环，`txId` 列表从环里**字典序最小的那个**起按
  等待方向排，多个环按首元素字典序排。
- 受害者：环里 **`startedAt` 最大**的那个（最年轻）；并列时挑 `txId` 字典序更大的。

作废一个事务（`abort`）会：清掉它的等待，把它持有的资源按 FIFO 让给下一个等待者，
之后它再来 `wait` / `release` 就是 `ERR_TX_ABORTED`。

`detect()` 返回 `{ cycles, victims, timeouts }`：`cycles` 是这轮发现的环，`timeouts` 是这轮
因超时作废的 `txId`，`victims` 是这轮实际作废掉的全部 `txId`（超时在前、环在后，各按处理顺序）。

### 查询与统计

- `snapshot()` → `{ transactions, resources }`，两个列表都按名字升序：
  事务行是 `{ txId, startedAt, holds, waitingFor, resource, aborted }`（`holds` 升序），
  资源行是 `{ resource, holder, waiters }`（`waiters` 保持 FIFO 顺序）。
- `stats()` → `{ transactions, held, waiting, grants, releases, cycles, aborts, timeouts }`：
  `transactions` 是登记过的事务总数，`held` 是此刻还有持有者的资源数，
  `waiting` 是此刻还在等的事务数，`grants` 包含直接拿到的和靠交接拿到的，
  `aborts` 是作废总数（超时也算），`timeouts` 只是其中因超时的部分。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_CONFIG` | `config` 不是对象、`clock` 不是函数或返回非有限数、`maxWaitMs` 不是正整数 |
| `ERR_BAD_ARGS` | `txId` / `resource` 不是非空字符串、`startedAt` 不是有限数、`timeoutMs` 不是正整数 |
| `ERR_UNKNOWN_TX` | `txId` 没登记过 |
| `ERR_DUPLICATE_TX` | 同一个 `txId` 登记两次 |
| `ERR_TX_ABORTED` | 已经被作废的事务还想 `wait` / `release` |
| `ERR_ALREADY_WAITING` | 这个事务已经有一个没满足的等待 |
| `ERR_ALREADY_HOLDER` | 去等一个自己已经拿着的资源 |
| `ERR_UNKNOWN_RESOURCE` | 释放一个从来没出现过的资源 |
| `ERR_NOT_HOLDER` | 释放一个自己没拿着的资源 |

## API

```js
import { createDeadlockDetector, DEFAULTS } from './lib/waitgraph.js';

let now = 0;
const detector = createDeadlockDetector({ clock: () => now, maxWaitMs: 100 });

detector.register({ txId: 't1', startedAt: 0 });
detector.register({ txId: 't2', startedAt: 10 });
detector.wait({ txId: 't1', resource: 'row-7' });     // -> granted
detector.wait({ txId: 't2', resource: 'row-7' });     // -> waitingFor: 't1'
detector.release({ txId: 't1', resource: 'row-7' });  // -> grantedTo: 't2'
now = 101;
detector.detect();                                    // -> { cycles, victims, timeouts }
detector.snapshot();
detector.stats();
```

出错一律抛 `WaitError`（`lib/errors.js`），按 `code` 分流。

## demo 跑出来应该长这样

`npm run demo` 里时间是写死的，输出每一行都能对上：

```
waitgraph demo
[1] 资源空着就先到先得
    grant {"txId":"t1","resource":"row-7","granted":true,"waitingFor":null}
[2] 后来的人在后面排队
    queue t2 等 t1
    queue t3 等 t1
    waiters t2,t3
[3] 释放时按 FIFO 交给最早排队的人
    handoff {"txId":"t1","resource":"row-7","released":true,"grantedTo":"t2"}
[4] 互相等待：检测出环，最年轻的那个被 abort
    cycles [["t4","t5"]]
    victims t5
    after row-11:t4 row-7:t2 row-9:t4
[5] 等太久算超时
    timeouts t3
[6] 统计
    {"transactions":5,"held":3,"waiting":0,"grants":5,"releases":1,"cycles":1,"aborts":2,"timeouts":1}
```
