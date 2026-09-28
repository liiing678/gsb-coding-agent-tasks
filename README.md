# raftlog

Raft 里日志复制那一块：任期、冲突截断、提交规则、日志压缩与 InstallSnapshot、单步成员变更，
全都由消息驱动，一步一步来，同样的消息序列必须走出同样的结果。跳过了选举和投票（那部分改成
在建立节点的时候直接指定谁是 leader）。只用 Node 标准库，没有第三方包，`node >= 20`。

```
raftlog/
├── lib/
│   ├── raftlog.js   createNode 与全部消息处理   ← 还没实现
│   └── errors.js    RaftlogError 与全部错误码
├── test/            log / cluster 两组用例
├── scripts/demo.mjs 手工过一遍的演示脚本
└── package.json     npm test / npm run demo
```

```
npm test        # 12 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 建节点

`createNode({ id, members, term = 0, leader = false, snapshot = { index: 0, term: 0 }, entries = [] })`

- `id` 非空字符串；`members` 是非空字符串数组、不能重样、**必须包含 `id`**；
  `term` 是非负整数；`leader: true` 表示这个节点现在就是 leader（跳过选举）。
- 日志下标**从 1 开始**。`snapshot.index`（默认 0）表示「1 到 index 这段已经进了快照」，
  传进来的 `entries` 从 `snapshot.index + 1` 开始**一个挨一个**排下去；每条是 `{ term, command }`。
- 节点自己要记的东西：`term`、`leaderId`（最近一条 `append` / `snapshot` 是谁发的，同任期里更新）、
  `commitIndex`（默认就是 `snapshot.index`）、`members`、日志、快照。
- leader 另外还要记每个 follower 的 `matchIndex` / `nextIndex`（一开始 `nextIndex = lastIndex + 1`）。
  新加进来的成员也一样：`nextIndex = lastIndex + 1`，如果它比 `snapshot.index` 还小，那就得先发快照。

### 看状态

- `state()` → `{ id, term, leader, leaderId, commitIndex, snapshot: { index, term }, members: [...],
  entries: [{ index, term }] }`（`entries` 只列快照之后还在的，command 不列）。
- `lastIndex()`：有日志就是最后一条的下标，没日志就是 `snapshot.index`；`lastTerm()` 同理。
- `termAt(index)` / `commandAt(index)`：`index` 必须在 `(snapshot.index, lastIndex()]` 里，
  不然报 `ERR_LOG_MISSING`；进了快照的那段 command 也拿不到（同样报 `ERR_LOG_MISSING`）。
- `snapshotNow()`：把 `commitIndex` 以及之前全吃进快照（丢日志、记下 `{ index, term }`），
  返回新的快照信息；`commitIndex` 没往前走过就什么都不做。

### 消息

```js
{ type: 'append',   from, to, term, prevIndex, prevTerm, entries: [{ term, command }], leaderCommit }
{ type: 'appendResponse', from, to, term, success, matchIndex?, conflictIndex? }
{ type: 'snapshot', from, to, term, lastIncludedIndex, lastIncludedTerm, members? }
{ type: 'snapshotResponse', from, to, term, success, matchIndex }
```

`node.step(message)` 处理一条进来的消息，返回**要发出去的消息数组**（通常一两条，没有就是 `[]`）。
`to` 不是自己的消息直接返回 `[]` 不管（总线上本来就有别人的消息）。

### 任期规则（先做这个）

- 消息的 `term` 比自己的小：**什么都不改**。`append` 回一条
  `{ type: 'appendResponse', ..., term: 自己, success: false, conflictIndex: lastIndex() + 1 }`；
  `snapshot` 回一条 `{ type: 'snapshotResponse', ..., success: false, matchIndex: 0 }`；
  `appendResponse` / `snapshotResponse` 直接丢掉。
- 消息的 `term` 比自己大：先把 `term` 抬上去；如果自己原来是 leader，**立刻不是 leader 了**，
  `leaderId` 清空、`matchIndex` / `nextIndex` / 待发快照的名单统统丢掉。

### append：follower 怎么处理

1. `leaderId = 消息.from`（同任期内）。
2. 对 `prevIndex` / `prevTerm`：
   - `prevIndex < snapshot.index` → 失败，`conflictIndex = snapshot.index + 1`；
   - `prevIndex > lastIndex()` → 失败，`conflictIndex = lastIndex() + 1`；
   - 落在日志里但 `termAt(prevIndex) !== prevTerm` → 失败，
     `conflictIndex` 取**那个 term 在这段日志里第一次出现的下标**；
   - `prevIndex === snapshot.index` 但 `prevTerm !== snapshot.term` → 失败，`conflictIndex = 0`
     （等于告诉 leader「你得给我发快照」）。
3. 对上了就接日志：从 `prevIndex + 1` 一条条比下去，遇到**下标一样但 term 不一样**的那条，
   把**它和它后面全部删掉**，再把消息里剩下的接上；比到消息结束就停。消息里 `entries` 是空的
   就是心跳，不动日志。
4. `commitIndex` 往前挪到 `min(leaderCommit, lastIndex())`（只前进，不后退），
   然后看这一段新提交的条目里有没有带 `config` 的，有就换成员表。
5. 回 `{ type: 'appendResponse', from: 自己, to: 消息.from, term: 自己, success: true,
   matchIndex: prevIndex + entries.length }`。

### appendResponse：leader 怎么处理

自己不是 leader 就丢掉。是 leader 就：

- 成功的：`matchIndex[from]` 只往前走到 `matchIndex`；`nextIndex[from] = matchIndex + 1`（也只往前走）。
- 失败的：`nextIndex[from] = max(1, conflictIndex)`；如果算出来的 `nextIndex` **不大于** `snapshot.index`，
  就把这个 follower 记进「待发快照」名单。
- 然后重算一次能提交到哪：把「自己（用 `lastIndex()`）和每个成员报上来的 `matchIndex`」排一排，
  取**第 floor(成员数 / 2) + 1 大的那个值**（也就是多数派都达到的最大下标）当候选；
  只有当候选 `> commitIndex` **而且** `termAt(候选) === 当前 term` 时才把 `commitIndex` 挪过去
  （所以上一个任期的条目要等当前任期有条目提交了才会跟着提交）。挪完同样要应用新提交的 `config` 条目。

### snapshot：InstallSnapshot

- `lastIncludedIndex <= commitIndex` → 什么都不动，回一条成功的 `snapshotResponse`。
- 否则：如果 `lastIncludedIndex <= lastIndex()` 而且 `termAt(lastIncludedIndex) === lastIncludedTerm`，
  就把 ≤ `lastIncludedIndex` 的日志丢掉、**后面的留着**；对不上就把日志全清掉。然后
  `snapshot = { index: lastIncludedIndex, term: lastIncludedTerm }`、
  `commitIndex = max(commitIndex, lastIncludedIndex)`；消息里带了 `members` 就换成员表。
- 回的 `snapshotResponse` 里 `success: true`、`matchIndex = lastIncludedIndex`。
- leader 收到成功的 `snapshotResponse`：`matchIndex` / `nextIndex` 往前走，并把那个 follower
  从「待发快照」名单里挪出来。

### 发消息

- `broadcast()` 只有 leader 能调（不是 leader 报 `ERR_NOT_LEADER`）：给**每个其它成员**出一条消息，
  按成员的顺序。
  - `nextIndex <= snapshot.index`（或者它在待发快照名单里）→ 发 `snapshot`
    （带上 `lastIncludedIndex` / `lastIncludedTerm` / 当前 `members`）；
  - 否则发 `append`：`prevIndex = nextIndex - 1`、`prevTerm = termAt(prevIndex)`、
    `entries` 是 `nextIndex` 往后还在的那几条、`leaderCommit = commitIndex`。
- `propose(command)` 只有 leader 能调：把 `{ term: 当前 term, command }` 接到自己日志尾巴上，
  返回 `{ index, term }`，然后照上面的规则试着提交一次（单节点集群自己就够了）。

### 成员变更

`command` 写成 `{ config: ['a', 'b', 'c'] }` 就是一条配置变更：

- 成员表本身得合法（非空、不重样、**含自己**），跟当前成员表比，**增和删加起来只能有一个人**
  （一次只能动一个成员），不然报 `ERR_BAD_CONFIG`。
- leader `propose` 这种条目时**立刻**按新配置走（新成员的 `nextIndex` 顺手补上）；
  follower 收到这种条目时先放着，等它**提交**了（`commitIndex` 越过它）才换自己的成员表。

## API

```js
import { createNode } from './lib/raftlog.js';

const leader = createNode({ id: 'a', members: ['a', 'b', 'c'], term: 1, leader: true });
const follower = createNode({ id: 'b', members: ['a', 'b', 'c'], term: 1 });

leader.propose('写一条');            // -> { index: 1, term: 1 }
leader.broadcast();                  // -> 给 b、c 的 append 消息
follower.step(leader.broadcast()[0]); // -> 一条 appendResponse
leader.step({ type: 'appendResponse', from: 'b', to: 'a', term: 1, success: true, matchIndex: 1 });
leader.state().commitIndex;          // -> 1（自己 + b 就到多数派了）
follower.state().leaderId;           // -> 'a'
leader.snapshotNow();                // -> { index: 1, term: 1 }
follower.termAt(1);                  // -> 1
```

出错一律抛 `RaftlogError`（`lib/errors.js`），按 `code` 分流：

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_CONFIG` | 成员表不合法（不是非空数组、有非字符串、重样、不含自己）、`id` / `term` / `snapshot` 不合法、`entries` 形状不对、`propose` 的 `config` 一次动了多个人 |
| `ERR_NOT_LEADER` | 不是 leader 还想 `propose` / `broadcast` |
| `ERR_LOG_MISSING` | `termAt` / `commandAt` 给的下标在快照之前或者超过 `lastIndex()`（进了快照的 command 也拿不到） |
| `ERR_BAD_MESSAGE` | 消息不是对象、`type` 不认识、`from` / `to` 不是非空字符串、`term` 不是非负整数，或者这种消息该有的字段没给 / 类型不对 |

## demo 跑出来应该长这样

```
raftlog demo
  propose {"index":1,"term":1}
  broadcast [{"to":"b","prevIndex":0,"prevTerm":0,"entries":1},{"to":"c","prevIndex":0,"prevTerm":0,"entries":1}]
  beforeAck 0
  afterAck 1
  follower {"id":"c","leaderId":"a","commitIndex":1}
  entries [{"index":1,"term":1}]
  conflict [{"type":"appendResponse","from":"b","to":"a","term":1,"success":false,"conflictIndex":1}]
  snapshot {"index":1,"term":1}
  afterSnapshot {"lastIndex":1,"commitIndex":1,"snapshot":{"index":1,"term":1}}
  compactRetry [{"to":"b","type":"append","prevIndex":1,"entries":0},{"to":"c","type":"snapshot","entries":null}]
  addMember {"index":2,"term":1}
  members ["a","b","c","d"]
  toD "d"
  bState {"term":1,"leader":false}
```
