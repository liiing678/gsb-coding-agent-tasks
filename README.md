# dedupstore

备份存储里那套"按内容切块、同样的块只存一份"的做法：切块用滑窗滚动哈希，
块的引用计数管着谁能被回收，快照把对象钉住不让删。
只用 Node 标准库（`node:crypto` 算 sha256），没有第三方包，`node >= 20`。

```
dedupstore/
├── lib/
│   ├── dedupstore.js  createDedupStore 本体             ← 还没实现
│   └── errors.js      DedupError 与全部错误码
├── test/              chunk / refs 两组用例
├── scripts/demo.mjs   手工过一遍的演示脚本
└── package.json       npm test / npm run demo
```

```
npm test        # 14 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 切块

`createDedupStore({ minBytes, maxBytes, windowBytes, boundaryBits, clock })`，默认
`minBytes = 64`、`maxBytes = 256`、`windowBytes = 16`、`boundaryBits = 6`。
校验：`minBytes >= 1`、`maxBytes >= minBytes`、`windowBytes >= 1`、`boundaryBits` 在 `1..24`。

`chunk(data)` 是纯函数，返回 `[{ offset, size, hash }]`，`hash` 是这一块字节的 **sha256 十六进制**。
切法（这块算法要一字不差地照做）：

- 常数 `BASE = 7919`，`mask = 2^boundaryBits - 1`，`pow = BASE^windowBytes mod 2^32`
  （`pow` 用 `>>> 0` 逐次乘出来）。
- **每一块都从 `h = 0` 重新开始**（切一刀就把窗口清空）。在这一块里按顺序处理每个字节：
  ```
  h = ((h * 7919) >>> 0 + data[i]) >>> 0
  如果 i - 块起点 >= windowBytes：
      h = (h - data[i - windowBytes] * pow) >>> 0
  ```
  也就是 `h` 是「最近 `windowBytes` 个字节」的滚动哈希（不足 `windowBytes` 时就是这一块的前缀哈希）；
  所有运算都按 32 位无符号回绕（`>>> 0`）。
- 处理完第 `i` 个字节后看这一块现在的长度 `size = i + 1 - start`：
  `size >= minBytes` 且 `(h & mask) === mask` 就在这儿切；
  `size >= maxBytes` 也强制切。
- 数据是空的时候返回 `[]`；最后一块是剩下的，**可以短于 `minBytes`**，永远不会长于 `maxBytes`。

### 对象与块

- `putObject({ id, data })`：`data` 是 `Uint8Array` / `Buffer`，`id` 不能重复。
  返回 `{ id, size, chunks, newChunks, reusedChunks }`：`chunks` 是切出来的块数，
  `newChunks` 是这轮第一次见到的块数，`reusedChunks = chunks - newChunks`。
  **库里存的是拷贝**，之后改传进来的数组不影响它。
- `getObject({ id })` 把内容拼回来，返回 `Buffer`（**也是拷贝**，改它不影响库里）。
- 每个块按 sha256 认身份，`refs` 记「被多少个对象引用」——同一个对象里同一块出现两次就加两次。
  `storedBytes` 是所有**不同块**的字节和，`logicalBytes` 是所有对象的字节和。
- `deleteObject({ id })` 只减引用、不删块，返回 `{ id, size, unreferencedChunks }`
  （`unreferencedChunks` 是这次引用掉到 0 的块数）；真正的回收交给 `gc()`：
  返回 `{ chunks, bytes }`，把 `refs === 0` 的块删掉。

### 快照

- `createSnapshot({ name, objects })`：`objects` 是对象 id 数组（重复的 id 只算一次）。
  名字不能重复，id 必须都存在。返回 `{ name, objects, bytes }`。
- 被任何快照引用着的对象**删不掉**：`deleteObject` 报 `ERR_OBJECT_PINNED`，
  `details.snapshots` 列出钉住它的快照名（升序）。
- `restoreSnapshot({ name })` → `{ name, objects: [{ id, size }], bytes }`；
  `dropSnapshot({ name })` → `{ name, dropped: true }`。

### 查询与自检

- `stats()` → `{ objects, snapshots, chunks, logicalBytes, storedBytes, dedupRatio }`，
  `dedupRatio = storedBytes === 0 ? 1 : Number((logicalBytes / storedBytes).toFixed(2))`。
- `integrity()` → `{ ok, problems }`：核每个对象的块长之和是否等于它的 `size`、
  每个块的 `refs` 是否等于实际被引用的次数；`problems` 按字符串升序，没问题就是空数组。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_CONFIG` | `config` 不是对象、`clock` 不是函数、`minBytes` / `maxBytes` / `windowBytes` / `boundaryBits` 不合法 |
| `ERR_BAD_ARGS` | 接口没给参数对象、`id` / `name` 不是非空字符串、`data` 不是 `Uint8Array` / `Buffer`、`objects` 不是数组 |
| `ERR_DUPLICATE_OBJECT` | 同一个对象 id 存两次 |
| `ERR_UNKNOWN_OBJECT` | 对象 id 没见过 |
| `ERR_OBJECT_PINNED` | 对象还被快照钉着就想删 |
| `ERR_DUPLICATE_SNAPSHOT` | 快照名重复 |
| `ERR_UNKNOWN_SNAPSHOT` | 快照名没见过 |

## API

```js
import { createDedupStore, DEFAULTS } from './lib/dedupstore.js';

const store = createDedupStore({ minBytes: 64, maxBytes: 256 });

store.chunk(Buffer.from('...'));                 // -> [{ offset, size, hash }]
store.putObject({ id: 'v1', data });             // -> { id, size, chunks, newChunks, reusedChunks }
store.getObject({ id: 'v1' });                   // -> Buffer
store.createSnapshot({ name: 'nightly', objects: ['v1'] });
store.deleteObject({ id: 'v1' });                // 被快照钉着就抛 ERR_OBJECT_PINNED
store.dropSnapshot({ name: 'nightly' });
store.gc();                                      // -> { chunks, bytes }
store.stats();
store.integrity();
```

出错一律抛 `DedupError`（`lib/errors.js`），按 `code` 分流。

## demo 跑出来应该长这样

`npm run demo` 里的数据是固定种子的伪随机字节，输出每一行都能对上：

```
dedupstore demo
[1] 存第一份：块都是新的
    put {"id":"v1","size":400,"chunks":24,"newChunks":24,"reusedChunks":0}
[2] 一模一样的内容再存一份：一个新块都不用建
    put {"id":"v2","size":400,"chunks":24,"newChunks":0,"reusedChunks":24}
[3] 内容翻倍（同一段拼两遍）：只有多出来的那半段算新块
    put {"id":"v3","size":800,"chunks":48,"newChunks":5,"reusedChunks":43}
[4] 前面插 3 个字节：只有开头那块会变
    put {"id":"v4","size":403,"chunks":25,"newChunks":1,"reusedChunks":24}
[5] 拿回来跟原样对得上
    get v3 true
[6] 快照把对象钉住
    snapshot {"name":"nightly","objects":["v1"],"bytes":400}
    delete ERR_OBJECT_PINNED nightly
[7] 删除 + 回收
    delete {"id":"v1","size":400,"unreferencedChunks":0}
    delete {"id":"v2","size":400,"unreferencedChunks":0}
    gc {"chunks":30,"bytes":478}
[8] 统计
    {"objects":0,"snapshots":0,"chunks":0,"logicalBytes":0,"storedBytes":0,"dedupRatio":1}
```
