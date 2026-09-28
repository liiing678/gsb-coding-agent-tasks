# chunkrelay

分片上传的会话引擎：客户端把大文件切片、乱序传，服务端负责收、去重、续传、收尾。
只用 Node 标准库，没有第三方包，`node >= 20`。

```
chunkrelay/
├── lib/
│   ├── relay.js      UploadRelay 本体                                    ← 还没实现
│   ├── errors.js     RelayError 与全部错误码
│   ├── hash.js       sha256Hex / EMPTY_SHA256
│   └── blobstore.js  只按 key 存字节的内存仓库（去重、配额都不在这里）
├── test/             session / store / restore 三组用例
├── scripts/demo.mjs  手工过一遍的演示脚本
└── package.json      npm test / npm run demo
```

```
npm test        # 25 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 会话与分片

- 一份文件 = 一个上传会话。`size` 是文件总字节数（可以是 0），`chunkSize` 是切片大小，
  分片数 `chunkCount = size === 0 ? 0 : ceil(size / chunkSize)`，下标从 0 开始。
- 每个分片的期望长度：不是最后一片就是 `chunkSize`，最后一片是 `size - index * chunkSize`。
  分片一旦定下来就不允许改大小，同一份文件重传的只能是同一套切法。
- 会话有 `id`，不传就按 `u-1`、`u-2`…… 生成（同一个实例内不重号，恢复快照后接着数）。
- `fingerprint` 是整份文件的 sha256 小写 hex，收尾时用来验货。
- 会话状态：`open` → `complete` / `aborted` / `expired`，只有 `open` 能收片。
  `complete` 的会话过了保留期会被清掉，清掉之后按「不认识的会话」处理。

### 收一片时要按这个顺序判定

1. 会话在不在、是不是 `open`；
2. 下标是不是 `0..chunkCount-1` 的整数；
3. 字节数是不是这一片的期望长度；
4. `hash` 是不是 64 位小写 hex；
5. 这一片内容的 sha256 是不是等于 `hash`；
6. 这个下标之前有没有收过别的内容；
7. 存储配额够不够（只有真的要新存一份字节时才看）。

前 5 步里任何一步不过，会话状态和已收分片都不能变，字节也不能落库 ——
判定发生在「这些字节确实属于这一片」的那一刻，不是等整个文件收完再回头算。
第 6 步：同一片重传同一份内容（sha256 相同）算幂等成功，不算错误；
同一片换一份内容是冲突，保留先收到的那份。

### 去重与引用

- 每片内容按自己的 sha256 存，内容一样的分片只存一份字节，同一次会话内、跨会话都一样。
- 每个存下来的 blob 记着谁在引用（`会话id#下标`）。引用清零就把字节删掉，
  并发 `blob-released` 事件。
- `stats().storedBytes` 是实际占的字节，`logicalBytes` 是几个会话按分片算下来的总量，
  `savedBytes` 是两者之差（去重省下来的）。

### 上限

| 项 | 默认值 | 说明 |
|---|---|---|
| `maxStoreBytes` | 64 MiB | 所有 blob 相加的存储上限，超了报 `ERR_STORE_FULL` |
| `chunkSize` | — | 1..1048576 的整数，越界算参数错误 |
| `ttlMs` | 1 小时 | `open` 的会话多久没人动就过期 |
| `completedTtlMs` | 5 分钟 | `complete` 的会话保留多久，过了就整个回收 |

配额是在落库那一刻判的：要新存一份字节、加上现有的超过上限就拒收，
这一片既不落库也不记进已收。命中已存在的 blob（去重）不占新字节，不受配额影响。

### 过期与回收

`sweep()` 用注入的时钟看一遍：

- `open` 且 `now - lastActivityAt >= ttlMs` → 状态变 `expired`，引用全部释放，
  发 `session-expired`；记录留着（客户端能看出来要重传），再对它做任何事都报 `ERR_NOT_OPEN`。
- `complete` 且 `now - completedAt >= completedTtlMs` → 记录直接删掉，引用释放，
  发 `session-released`；之后按不认识的会话报 `ERR_UNKNOWN_UPLOAD`。
- 返回 `{ expired: [...], released: [hash...] }`。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_REQUEST` | `create` 的参数不合法（name / size / chunkSize / fingerprint / id） |
| `ERR_UNKNOWN_UPLOAD` | 这个会话号没有（含已经被回收的） |
| `ERR_NOT_OPEN` | 会话不是 `open`（`complete` / `aborted` / `expired`） |
| `ERR_CHUNK_OUT_OF_RANGE` | 分片下标不是合法整数或越界 |
| `ERR_CHUNK_SIZE` | 这一片的字节数和期望长度不一样 |
| `ERR_BAD_HASH` | `hash` 不是 64 位小写 hex |
| `ERR_CHUNK_HASH_MISMATCH` | 内容算出来的 sha256 和传上来的 `hash` 对不上 |
| `ERR_CHUNK_CONFLICT` | 同一片之前收过另一份内容 |
| `ERR_STORE_FULL` | 新存这份字节会超过 `maxStoreBytes` |
| `ERR_INCOMPLETE` | 收尾时还有分片没到，`details.missing` 是从小到大的下标 |
| `ERR_FINGERPRINT_MISMATCH` | 拼出来的整份文件 sha256 和 `fingerprint` 对不上 |
| `ERR_BAD_SNAPSHOT` | 快照版本不认识 |

## API

```js
import { UploadRelay, DEFAULTS } from './lib/relay.js';
```

### `new UploadRelay(options)`

`options`：`store`（默认内存仓库）、`maxStoreBytes`、`ttlMs`、`completedTtlMs`、
`now`（取当前时间的函数，默认 `Date.now`）。

### `create({ name, size, chunkSize, fingerprint, id? })`

返回会话描述：

```js
{
  id: 'u-1',
  name: 'report.pdf',
  size: 26, chunkSize: 10, chunkCount: 3,
  state: 'open',
  fingerprint: '...',
  received: [0, 2],        // 已经收到的下标，从小到大
  missing: [1],            // 还差的下标，从小到大
  receivedBytes: 16,
  createdAt: 1000, lastActivityAt: 1000, completedAt: 0,
}
```

`status(id)` 返回同样的形状。

### `putChunk(id, index, bytes, hash)`

`bytes` 是 `Buffer` 或 `Uint8Array`，`hash` 是这一片内容的 sha256。返回
`{ index, size, hash, deduped }`：`deduped` 表示这份字节之前就存过了（去重命中或重复上传）。
出错一律抛 `RelayError`。

### `complete(id)` / `abort(id)`

- `complete` 校验分片齐不齐、整份文件 sha256 对不对，都过了就返回拼好的 `Buffer`
  （空文件返回长度 0 的 `Buffer`），会话变 `complete`。
  `fingerprint` 对不上时抛 `ERR_FINGERPRINT_MISMATCH`，会话保持 `open`、已收的分片一个不丢，
  客户端重传坏的那片就行。
- `abort` 返回 `{ uploadId, freed: [hash...] }`，会话变 `aborted`，引用全部释放。

### `sweep()` / `stats()`

见《过期与回收》。`stats()` 返回
`{ sessions, openSessions, blobs, storedBytes, logicalBytes, savedBytes }`；
`logicalBytes` 只算 `open` / `complete` 的会话。

### `snapshot()` / `restore(snapshot)`

`snapshot()` 返回一个能 `JSON.stringify` 的普通对象（blob 内容是 base64），
`restore(snapshot)` 把状态灌回一个实例（store 里也补齐字节），之后接着收片、收尾、
继续记事件都跟没重启过一样，`seq` 和自动编号都接着数。

### `onEvent(fn)`

订阅事件，返回退订函数。事件是同步发的，`seq` 从 1 开始连着涨。

| 事件 | 什么时候 | 自带字段 |
|---|---|---|
| `session-created` | `create` 返回前 | `size` `chunkSize` `chunkCount` |
| `blob-stored` | 新存了一份字节 | `hash` `size` |
| `blob-reused` | 命中已有的 blob，没占新字节 | `hash` `size` |
| `chunk-accepted` | 一片收下了 | `index` `hash` `size` `deduped` |
| `chunk-redundant` | 同一片重传了同一份内容 | `index` `hash` `size` |
| `session-completed` | 收尾成功 | `size` `sha256` `name` |
| `session-aborted` | `abort` 成功 | — |
| `session-expired` | 会话超时 | `idleMs` |
| `session-released` | `complete` 的会话过了保留期被回收 | `size` |
| `blob-released` | 最后一个引用没了，字节删掉 | `hash` `size` |

每条事件都带 `uploadId`。同一片里 `blob-stored` / `blob-reused` 在前、`chunk-accepted` 在后。

## demo 跑出来应该长这样

`npm run demo` 里的内容和时钟都是写死的，输出每一行都能对上
（`sha256=` 后面是整份文件 sha256 的前 12 位）：

```
chunkrelay demo
[1] 一块块乱序传，中间重传一次
    create u-1 size=26 chunkSize=10 chunkCount=3
    put #2 6B -> deduped=false
    put #0 10B -> deduped=false
    put #0 10B -> deduped=true
    put #1 10B -> deduped=false
    status received=[0,1,2] missing=[]
    complete -> 26B sha256=587f304fdebd
[2] 同样内容的第二份文件，字节只存一份
    events session-created,blob-reused,chunk-accepted,session-completed
    stats blobs=3 storedBytes=26 logicalBytes=52 savedBytes=26
[3] 存储只剩一点点额度，新内容直接被拒
    reject ERR_STORE_FULL: 需要 40B，现在有 26B
[4] 换一个进程接着传，再把过期的清掉
    restored sessions=3 blobs=3
    sweep expired=[u-3] released=3
    stats blobs=0 storedBytes=0
```
