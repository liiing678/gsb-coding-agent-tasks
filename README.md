# mvccstore

内存里的多版本 KV：读写都走事务、快照隔离（一个事务从开始那一刻看世界，别人后来的提交它看不见）、
写同一个 key 的并发事务后提交的那个报冲突，旧版本还能按需回收，不让人一直跑内存就一直涨。
只用 Node 标准库，没有第三方包，`node >= 20`。

```
mvccstore/
├── lib/
│   ├── store.js     createStore 本体                     ← 还没实现
│   └── errors.js    MvccError 与全部错误码
├── test/            txn / store 两组用例
├── scripts/demo.mjs 手工过一遍的演示脚本
└── package.json     npm test / npm run demo
```

```
npm test        # 14 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 配置

`createStore({ maxKeyLength })`：

- `maxKeyLength` 默认 256，必须是正整数，否则 `ERR_BAD_CONFIG`；配置不是对象也一样。
- 没有时钟：版本号是**逻辑**的，跟真实时间无关。

### 版本号与快照

- `commitTs` 从 0 开始，**每成功提交一次加一**（写集是空的事务也占一个号）。
- `begin()` 拿到的快照就是"那一刻的 `commitTs`"：这个事务只看得到 `commitTs <= 快照` 的版本，
  自己之后别人提交的东西一概看不见。
- 事务对象上有 `id`（`txn-1`、`txn-2`……）、`snapshot`、`state`
  （`active` / `committed` / `aborted`）。

### 事务

- `get(key)`：先看自己写集，再看快照可见的最新版本；**不存在的 key、以及最新那一版是删除的 key，
  都返回 `undefined`**。
- `put(key, value)`：value 不能是 `undefined`（要删就用 `delete`），key 必须是长度 1 ~
  `maxKeyLength` 的字符串。
- `delete(key)`：记一条墓碑，key 存不存在都能删。
- `scan(from, to)`：**半开区间 `[from, to)`**，`from` / `to` 不给就是不设这一头的边界，
  按 key 升序（JS 字符串的码元序）；结果里**含自己没提交的写入，也含自己没提交的删除**
  （删掉的不出现在结果里）。
- `commit()` → `{ commitTs, writes }`：`writes` 是写集大小。
  **冲突检测**：写集里任何一个 key，如果它的最新已提交版本的 `commitTs` 大于本事务的快照，
  就是写写冲突——整个事务作废（`state` 变 `aborted`，写集全丢），抛 `ERR_CONFLICT`，
  `details` 里是 `{ txnId, keys }`，`keys` 按码元序排好。
  只读过、没写过的 key 被别人改了**不算**冲突。
- `abort()`：丢掉写集，返回 `true`；事务已经结束（提交过或回滚过）就返回 `false`，**不抛异常**。
- 已经结束的事务上再调 `get` / `put` / `delete` / `scan` / `commit`，一律抛 `ERR_TXN_CLOSED`。

### 库级读

- `get(key)` / `scan(from, to)` 读的是**最新已提交**的那一版（不含任何未提交的写），
  墓碑不出现在结果里。

### 版本回收

`collect()` 把没人再需要的旧版本扔掉，返回扔掉几条，累加进 `stats().collected`。留谁：

- 每个 key 的**最新版本**永远留着（哪怕是墓碑）；
- 每个**活跃事务**的快照，它在每个 key 上看得见的那个版本也要留着，否则老事务会读到空。

其余的非最新版本可以回收。

### 深拷贝

`put` 写进去时拷贝一份，`get` / `scan` 读出来也拷贝一份：外面改传进去的对象、或者改读出来的结果，
都不影响库里存的那份。

### 统计

`stats()` → `{ commitTs, activeTxns, keys, versions, commits, aborts, conflicts, collected }`：
`keys` 是最新版本不是墓碑的 key 数，`versions` 是当前存着的版本总数（含墓碑），
其余是累计计数。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_CONFIG` | 配置不是对象、`maxKeyLength` 不是正整数 |
| `ERR_BAD_KEY` | key 不是字符串、是空串、或超过 `maxKeyLength` |
| `ERR_BAD_VALUE` | `put` 的 value 是 `undefined`，或者深拷贝不了 |
| `ERR_BAD_RANGE` | `scan` 的 `from` / `to` 不是字符串，或者 `from > to` |
| `ERR_TXN_CLOSED` | 事务已经结束还去 `get` / `put` / `delete` / `scan` / `commit` |
| `ERR_CONFLICT` | 提交时发现写集里的 key 被别的事务改过 |

## API

```js
import { createStore, DEFAULTS } from './lib/store.js';

const store = createStore({ maxKeyLength: 256 });

const txn = store.begin();          // { id: 'txn-1', snapshot, state, get, put, delete, scan, commit, abort }
txn.put('user:1', { name: 'ann' });
txn.delete('user:2');
txn.get('user:1');                  // -> { name: 'ann' }
const { commitTs, writes } = txn.commit();

store.get('user:1');                // 最新已提交的值，没有就是 undefined
store.scan('user:1', 'user:9');     // -> [{ key, value }, ...]，半开区间、按 key 升序
store.collect();                    // -> 回收了几条旧版本
store.stats();                      // -> 统计

const busy = store.begin();
busy.put('user:1', { name: 'bob' });
busy.commit();                      // 如果有别的事务在它开始后改过 user:1 —— 抛 ERR_CONFLICT
```

出错一律抛 `MvccError`（`lib/errors.js`），按 `code` 分流。

## demo 跑出来应该长这样

`npm run demo` 里没有真实时间，输出每一行都能对上：

```
mvccstore demo
[1] 一个事务里写两条，提交后一起可见
    a=1 b=2
[2] 快照隔离：老事务看不到后来的提交
    老事务看到 a=1，最新是 a=9
[3] 并发写同一个 key，后提交的那个报冲突
    ERR_CONFLICT: txn-2 写过的 a
[4] 删掉的 key 留墓碑，读出来是 undefined
    b=undefined keys=1
[5] collect 回收没人要的旧版本
    回收 2 条，剩 2 条版本
[6] 统计
    {"commitTs":3,"activeTxns":0,"keys":1,"versions":2,"commits":3,"aborts":1,"conflicts":1,"collected":2}
```
