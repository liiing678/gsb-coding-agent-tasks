# twopc

跨库写的两阶段提交：协调器先问所有参与者能不能提交，全票通过才提交，有一个不同意就回滚；
决定之后要保证每个参与者都收到，谁没回执就按退避重发；协调器自己崩了重启，也不能把已经决定的事情改掉。
只用 Node 标准库，没有第三方包，`node >= 20`。

```
twopc/
├── lib/
│   ├── coordinator.js createCoordinator 本体              ← 还没实现
│   └── errors.js      TwopcError 与全部错误码
├── test/              decide / recover 两组用例
├── scripts/demo.mjs   手工过一遍的演示脚本
└── package.json       npm test / npm run demo
```

```
npm test        # 12 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 模型

协调器自己不发电网：**要发的消息攒在 outbox 里**，调用方 `outbox()` 取走（取走即清空）再投递；
参与者回话通过 `receive(message)` 送进来。参与者本体不在这个仓库里。

### 配置

`createCoordinator({ clock, participants, prepareTimeoutMs, retryBackoffMs })`：

- `participants` 是不重名的非空字符串数组；
- `prepareTimeoutMs` 默认 30000，`retryBackoffMs` 默认 1000，都是正整数；
- `clock` 不给就用系统时间，**"现在几点"只走 clock**。

### 发出去的消息

| 消息 | 什么时候发 | 形状 |
|---|---|---|
| prepare | `begin` 之后，给每个参与者 | `{ to, txnId, type: 'prepare', ops, attempt: 1 }` |
| commit | 决定提交之后，给每个参与者 | `{ to, txnId, type: 'commit' }` |
| abort | 决定回滚之后，给每个参与者 | `{ to, txnId, type: 'abort', reason }` |

### 事务生命周期

`begin({ id, ops })` → `{ id, state: 'preparing', decision: null, deadline }`：

- `id` 是非空字符串，**用过的 id 不能再用**（包括已经做完的）；
- `ops` 是要随 prepare 发下去的负载（可省略，默认 `[]`，必须是数组）；
- 顺手写一条 `BEGIN` 日志。

状态：`'preparing'`（等投票）→ `'committing'` / `'aborting'`（决定已下，等回执）→ `'done'`（回执收齐）。

### 投票与决定

`receive({ from, txnId, type: 'vote', vote: 'yes' | 'no' })`：

- **全都投 yes** → 决定 `commit`；
- **有一个人投 no** → 立刻决定 `abort`（`reason` 是 `'VOTE_NO'`），不等剩下的人；
- 还没投齐就一直等，超时交给 `tick()`；
- 已经决定之后再来的投票、同一个人重复投票，都算重复投递：`duplicates` 加一、返回 `false`。

决定会写一条 `DECISION` 日志，并把决策发给**每一个**参与者。

`receive({ from, txnId, type: 'ack' })` → 参与者回执：

- 还没决定就收到 ack → `ERR_BAD_MESSAGE`；
- 每个参与者只认第一次 ack（重复的算 `duplicates`，返回 `false`），写一条 `ACK` 日志；
- 所有人都 ack 之后事务变 `done`，再写一条 `DONE` 日志。

### 超时与重发（tick）

`tick()` 按当前 clock 推一遍，返回这一趟发生了什么事（数组，可能为空）：

- `'preparing'` 并且 `now - startedAt >= prepareTimeoutMs` → 决定 `abort`，`reason` 记
  `'PREPARE_TIMEOUT'`，事件是 `{ type: 'abort', txnId, reason }`；
- `'committing'` / `'aborting'` 并且 `now - lastSentAt >= retryBackoffMs` → **只给还没 ack 的人**
  重发决策，事件是 `{ type: 'resend', txnId, decision, to }`，每个收件人算一次 `resends`。

### 崩溃与恢复

- `crash()`：内存里的东西全丢（事务、outbox、**计数**都清零），**日志留着**；
  崩溃期间 `begin` / `receive` / `tick` 一律 `ERR_BAD_STATE`，崩两次也是。
- `recover()`：按日志重建，返回"需要接手的事务数"：

  | 日志里的情况 | 恢复之后 |
  |---|---|
  | 只有 `BEGIN`（还没写决策） | 决定 `abort`，`reason` 是 `'RECOVERED'`，发给所有人 |
  | 有 `DECISION` 但回执没收齐 | **决策不变**，只给日志里没 ack 过的人补发 |
  | 有 `DECISION` 且回执收齐 | 直接当 `done`，一条都不发 |

  `begun` / `committed` / `aborted` / `acks` 这几个计数恢复后按日志重建；
  `duplicates` / `resends` / `recovered` 是内存计数，崩溃之后就重新开始。
  恢复时给"还没决定过"的事务发第一条决策**不算重发**，`resends` 不加。

### 查询

- `status(id)` → `{ id, state, decision, reason, votes, acked, startedAt, lastSentAt }`，
  `votes` 是"已投票参与者 → yes/no"，`acked` 按名单顺序列出已经回执的人；
- `pending()` 是还没 `done` 的事务，按 `startedAt`、`id` 排；
- `log()` 是日志副本（每条有 `seq` 和 `at`）；
- `stats()` → `{ begun, committed, aborted, acks, duplicates, resends, recovered }`。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_CONFIG` | 配置不是对象、`participants` 不合法、超时/退避不是正整数、`clock` 不是函数 |
| `ERR_BAD_TXN` | `begin` 的 `id` 不是非空字符串、`ops` 不是数组 |
| `ERR_DUPLICATE_TXN` | 这个 id 以前用过 |
| `ERR_UNKNOWN_TXN` | 消息或 `status` 里的 `txnId` 没见过 |
| `ERR_UNKNOWN_PARTICIPANT` | 消息的 `from` 不在参与者名单里 |
| `ERR_BAD_MESSAGE` | 消息缺 `from` / `txnId`、类型不认识、`vote` 不是 yes/no、没决定就来 ack |
| `ERR_BAD_STATE` | 崩溃期间还调 `begin` / `receive` / `tick`、重复崩溃、没崩就 `recover` |

## API

```js
import { createCoordinator, DEFAULTS, MESSAGE_TYPES, REPLY_TYPES } from './lib/coordinator.js';

const coordinator = createCoordinator({
  clock: () => Date.now(),
  participants: ['p1', 'p2', 'p3'],
  prepareTimeoutMs: 5000,
  retryBackoffMs: 1000,
});

coordinator.begin({ id: 't1', ops: [{ k: 'a' }] });
coordinator.outbox();                        // -> 三条 prepare，取走即清空
coordinator.receive({ from: 'p1', txnId: 't1', type: 'vote', vote: 'yes' });
coordinator.receive({ from: 'p2', txnId: 't1', type: 'vote', vote: 'yes' });
coordinator.receive({ from: 'p3', txnId: 't1', type: 'vote', vote: 'yes' });
coordinator.outbox();                        // -> 三条 commit
coordinator.receive({ from: 'p1', txnId: 't1', type: 'ack' });
coordinator.tick();                          // -> 到点了就给没回执的人重发
coordinator.status('t1');                    // -> 事务当前的样子
coordinator.crash();
coordinator.recover();                       // -> 按日志接手没做完的事务
coordinator.stats();
```

出错一律抛 `TwopcError`（`lib/errors.js`），按 `code` 分流。

## demo 跑出来应该长这样

`npm run demo` 里时间是写死的，输出每一行都能对上：

```
twopc demo
[1] begin 之后每个参与者都收到 prepare
    p1:prepare p2:prepare p3:prepare
[2] 三个人都投 yes，才拍板提交
    决定 commit，发出 p1:commit p2:commit p3:commit
[3] p3 一直不回 ack，过了退避时间就只给它重发
    {"type":"resend","txnId":"t1","decision":"commit","to":["p3"]}
    重发 p3:commit
    t1 状态 done
[4] 有人投 no 就立刻回滚，不等剩下的人
    t2 决定 abort，原因 VOTE_NO
    发出 p1:abort p2:abort p3:abort
[5] 票一直没投齐，超时之后回滚
    {"type":"abort","txnId":"t3","reason":"PREPARE_TIMEOUT"}
[6] 崩溃恢复：没决策的回滚，决策过的只补发没 ack 的
    崩溃前日志里有 29 条，内存计数已经清零（begun=0）
    恢复 2 个事务
    t5 -> abort/RECOVERED
    t4 -> commit/committing，补发 p2:commit p3:commit p1:abort p2:abort p3:abort
[7] 统计
    {"begun":5,"committed":2,"aborted":3,"acks":10,"duplicates":0,"resends":2,"recovered":1}
```
