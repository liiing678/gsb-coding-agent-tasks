# durakv

本地 KV 存储：先写日志再改内存，进程被杀掉、日志写到一半断电都还能回到上一次提交过的状态，
并且能按版本号读历史。只用 Node 标准库，`node >= 20`。

```
durakv/
├── lib/
│   ├── store.js    createStore 本体：事务、恢复、快照读     ← 还没实现
│   ├── codec.js    日志帧编解码：长度 + crc32 + 类型 + JSON
│   ├── log.js      只当字节用的追加日志（append / truncate / dropPrefix）
│   └── errors.js   KVError 与全部错误码
├── test/           txn / recovery / snapshot 三组用例
├── scripts/demo.mjs
└── package.json    npm test / npm run demo
```

```
npm test        # 23 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 写入路径

一个写事务长这样：`begin()` 拿事务，`set` / `del` 往事务里加操作，`commit` 收尾。

- `set` / `del` 一被调用就**立刻往日志追加一帧**（`PUT` / `DEL`），但内存里的数据不动；
- `commit` 追加一帧 `COMMIT`（带上提交后的版本号），然后才把这些操作应用到内存；
- `rollback` 什么都不写，只在内存里把这个事务作废。已经追加下去的 `PUT` / `DEL` 帧留在日志里，
  因为后面没有 `COMMIT`，恢复时不会被认下来，checkpoint 之后就没了。
- 事务只能用一个：提交过或者回滚过再动它就报 `ERR_TXN_CLOSED`。
  事务 id 只在当前进程内有意义，恢复之后从 `t-1` 重新数（没提交的事务本来就已经丢了）。
- `set` / `del` 的第一个参数可以是 `begin()` 返回的对象，也可以是它的 id 字符串。
- 每次 `commit` 让版本号 +1，从 1 开始。**空事务也占一个版本号**。
- 值只支持字符串，按 UTF-8 字节数算长度，超过 `maxValueBytes` 直接拒，一个字节都不写。

### 恢复

构造 `createStore` 的时候就会就地重放日志，恢复规则只有三条：

1. 从头一帧一帧读。**读到一半就断了的帧**（长度不够、头都不全）算撕裂，不认，日志截到那一帧之前。
2. 帧里的 crc32 和负载对不上，说明中间坏过：从这一帧开始**后面的全部不要**，日志同样截回去。
   这样后续 append 还能接着用。
3. 只有 `COMMIT` 帧才让一个事务生效。日志里躺着没有 `COMMIT` 的 `PUT` / `DEL`（写到一半被杀、
   事务还没提交），恢复时一律丢掉。

恢复之后版本号取日志里出现过的最大的已提交版本，接着提交就从下一个版本号开始。
`stats().recovery` 会说清楚这次恢复发生了什么：`reason` 是 `clean` / `torn` / `bad-crc` /
`bad-frame`，`frames` 是认下来的帧数，`droppedBytes` 是被切掉的字节数。

### 快照读

- 每个 key 的每次写入都在历史上留一条 `{ version, value }`，删除记成 `value: null` 的墓碑。
- `get(key, atVersion)` / `scan(prefix, atVersion)` 读的是「在 `atVersion` 这个版本上生效的值」，
  也就是历史上第一条 `version <= atVersion` 的记录；墓碑读出来是 `null`。
  `atVersion` 不传就是当前版本，取值范围 `0..当前版本`（0 表示什么都还没有）。
- `history(key)` 把这个 key 的全部历史按版本升序给出来，墓碑是 `{ version, value: null }`。

### checkpoint

`checkpoint()` 把当前全部状态（含每个 key 的完整历史）写成一帧 `SNAPSHOT` 追加在日志末尾，
然后把快照之前的部分丢掉，日志就只剩这一帧。顺序不能反：先追加再丢前缀，
这样两步之间断电，恢复出来还是对的（老日志会被重放，然后被快照覆盖）。

- 还有没提交的事务时报 `ERR_PENDING_TXNS`，先提交或者回滚。
- 快照里带着完整历史，所以 checkpoint 之后 `get(key, 老版本)` 照样查得到。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_KEY` | key 不是非空字符串 |
| `ERR_BAD_VALUE` | value 不是字符串 |
| `ERR_VALUE_TOO_LARGE` | value 的 UTF-8 字节数超过 `maxValueBytes` |
| `ERR_UNKNOWN_TXN` | 事务号不认识 |
| `ERR_TXN_CLOSED` | 事务已经提交或回滚过了 |
| `ERR_BAD_VERSION` | 版本号不是 `0..当前版本` 的整数 |
| `ERR_PENDING_TXNS` | checkpoint 的时候还有没提交的事务 |

## API

```js
import { createStore, DEFAULTS } from './lib/store.js';
const store = createStore({ log, maxValueBytes, now });
```

`options`：`log`（默认给一个内存日志，见 `lib/log.js`）、`maxValueBytes`（默认 256 KiB）、
`now`。

| 方法 | 说明 |
|---|---|
| `begin()` | 返回 `{ id, openedAt }` |
| `set(txn, key, value)` | 返回 `{ txnId, key, size }`，`size` 是 UTF-8 字节数 |
| `del(txn, key)` | 返回 `{ txnId, key }` |
| `commit(txn)` | 返回 `{ txnId, version, ops, walBytes }` |
| `rollback(txn)` | 返回 `{ txnId, ops }` |
| `get(key, atVersion?)` | `{ key, value, version }` 或 `null` |
| `scan(prefix?, atVersion?)` | `[{ key, value, version }]`，按 key 升序 |
| `history(key)` | `[{ version, value }]` |
| `checkpoint()` | 返回 `{ version, walBytes }` |
| `stats()` | `{ version, keys, entries, walBytes, liveBytes, pendingTxns, recovery }` |

`keys` 是当前还活着的 key 数（墓碑不算），`entries` 是内存里登记过的 key 数（含只剩墓碑的），
`liveBytes` 是历史里所有非墓碑 value 的字节数。

`lib/codec.js` 和 `lib/log.js` 已经是成品，不要再改：`encodeFrame(type, body)` 出一帧字节、
`decodeFrames(buffer)` 返回 `{ frames, end, reason }`（`end` 是可以安全保留的字节数）、
`crc32(bytes)`；日志那边是 `append` / `bytes` / `truncate(len)` / `dropPrefix(len)` / `size`。

## demo 跑出来应该长这样

`npm run demo` 里的事务和字节数都是写死的，输出每一行都能对上：

```
durakv demo
[1] 两个事务提交，一个事务写了一半就不管了
    commit t-1 -> version 1
    commit t-2 -> version 2
    t-3 只写了没提交，日志里有它的帧
    user:1 = ann-w，user:2 = null
    walBytes=316 frames=7
[2] 拿日志从头上重开一个 store（等于进程重启）
    version=2 keys=1
    user:3 = null，没提交的那次没留下任何东西
    user:1 在版本 1 上是 ann
[3] 尾部那帧写到一半断电（最后 7 个字节没了）
    recovery reason=torn droppedBytes=44（那一帧整个不要）
    version=2 user:1 = ann-w
[4] checkpoint 把日志收一收
    checkpoint version=2 walBytes 316 -> 100
    重开之后 version=2 keys=1
    user:1 在版本 1 上仍然是 ann
```
