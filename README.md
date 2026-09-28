# merkleproof

一个只进不出的 Merkle 日志：叶子哈希、节点哈希、树根，加上「某个叶子在这棵树里」的包含证明
和「老树是新树前缀」的一致性证明，都按 RFC 6962 那套拆树口径来。用 `node:crypto` 的
SHA-256，没有第三方包，`node >= 20`。

```
merkleproof/
├── lib/
│   ├── merkletree.js   createLog 与两个 verify   ← 还没实现
│   └── errors.js       MerkleError 与全部错误码
├── test/               merkle / verify 两组用例
├── scripts/demo.mjs    手工过一遍的演示脚本
└── package.json        npm test / npm run demo
```

```
npm test        # 13 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

哈希一律是 **SHA-256，小写十六进制 64 个字符**。

- `leafHash(data)` = `SHA256(0x00 || utf8(data))`（`data` 是字符串）。
- `nodeHash(left, right)` = `SHA256(0x01 || bytes(left) || bytes(right))`。
- 空树的根（`size() === 0`）就是 `SHA256()`（零字节输入）。
- 树根 `MTH(D[0:n])`：`n === 0` 用空树根；`n === 1` 就是那条叶子的哈希；否则取
  **小于 n 的最大的 2 的幂** `k`，`MTH(D[0:k])` 和 `MTH(D[k:n])` 各算一棵再接起来。
  注意 `n === 2` 时 `k === 1`，`n === 4` 时 `k === 2`（不是 4）。

**包含证明** `inclusionProof(index)`：按上面同一套拆分递归下去，每次从目标所在的那半边继续，
把**另一边**那棵子树的 `MTH` 依次记下来。也就是

```
path(m, lo, n): n === 1 → []
  k = 小于 n 的最大的 2 的幂
  m - lo < k → path(m, lo, k) 接上 MTH(D[lo+k : lo+n])
  否则       → path(m, lo+k, n-k) 接上 MTH(D[lo : lo+k])
```

证明是**有序**的，校验时按同样顺序取用。

**一致性证明** `consistencyProof(fromSize)`（记 m = `fromSize`、n = 当前 `size()`）：
m === 0 或 m === n 时是空数组；否则按

```
sub(m, lo, n, whole): n === m → whole ? [] : [MTH(D[lo:lo+n])]
  k = 小于 n 的最大的 2 的幂
  m <= k → sub(m, lo, k, whole) 接上 MTH(D[lo+k : lo+n])
  否则   → sub(m-k, lo+k, n-k, false) 接上 MTH(D[lo : lo+k])
```

最外层 `whole` 是 `true`（意思是「这棵子树整个都属于老树」）。`whole` 会顺着
`m <= k` 那条路一直传下去，只在那一次「递归到 n === m」时起作用：这时候整棵子树就是老树本身，
不用再往证明里塞一个哈希。

**校验**：`verifyInclusion` / `verifyConsistency` 按**生成时同样的递归顺序**取用证明里的哈希，
从叶子（或老树根）往上拼出树根，跟传进来的 `root` / `toRoot` 比；同时要求证明**不多不少**
刚好用完。任何一处不对（拼出来的根不一样、证明多一个少一个、顺序换了、`index` / `size`
换掉）都返回 `false`。

- `verifyInclusion`：`size === 0` 或 `index >= size` 也是 `false`。
- `verifyConsistency`：`fromSize > toSize` 是 `false`；`fromSize === 0` 要求证明为空**而且**
  `fromRoot` 正好是空树根；`fromSize === toSize` 要求证明为空而且两个根相等。
- 只有**参数形状**不对才抛错（详见下面的错误码表），值对不上是 `false`，不抛。

## API

```js
import { createLog, leafHash, nodeHash, verifyInclusion, verifyConsistency } from './lib/merkletree.js';

leafHash('leaf-0');                       // -> 64 位小写 hex
nodeHash(leafHash('a'), leafHash('b'));   // -> 64 位小写 hex

const log = createLog();
log.append('leaf-0');        // -> { index: 0, hash: '...' }
log.appendAll(['a', 'b']);   // -> [{ index, hash }, ...]
log.size();                  // 3
log.root();                  // 树根（空 log 就是空树根）
log.leafAt(1);               // 第 1 条叶子的哈希

const proof = log.inclusionProof(2);        // -> { index: 2, size: 3, path: ['...', ...] }
verifyInclusion({ ...proof, leaf: log.leafAt(2), root: log.root() });   // -> true

const consistency = log.consistencyProof(1);  // -> ['...', ...]
verifyConsistency({
  fromSize: 1, fromRoot: <size=1 那棵树的根>,
  toSize: 3, toRoot: log.root(), path: consistency,
});                                          // -> true
```

出错一律抛 `MerkleError`（`lib/errors.js`），按 `code` 分流：

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_ARGUMENT` | 叶子不是字符串、哈希不是 64 位小写十六进制、`index` / `size` / `fromSize` / `toSize` 不是非负整数、`path` 不是数组或里面不是哈希、`verify*` 收的不是对象 |
| `ERR_OUT_OF_RANGE` | `leafAt` / `inclusionProof` 的 `index` 超出 `[0, size)`、`consistencyProof` 的 `fromSize > size()` |

## demo 跑出来应该长这样

```
merkleproof demo
  size 6
  root a9b300c50dbb0db0821cbb6f27c94fbb2b00d256041b0c788033a6b1fb1151d4
  leaf2 4fb70daa0a6daaf7e93f2b37c5e5df73346630fd8a51996d50f1d8eeff279426
  inclusion2 ["5f3e698cf937622aca7c6bf273ef2176092ec33c162dccae39df8701625d189f","3fd1d5a059ab171a345f9912c83c2dd8b7933b4e950e6749bc83dbb1f43ccbde","35a34418ee4343aa51ebc6e97899075c467f12dd217aea54cc2d71581813d413"]
  verify true
  verifyTampered false
  consistency4 ["35a34418ee4343aa51ebc6e97899075c467f12dd217aea54cc2d71581813d413"]
  consistencyOk true
  consistencyBad false
  emptyRoot e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  bigRoot 532f357123084cc9b2870114e3cb843de1e3cca27b39d004de42c445888ebb2e
  bigVerify true
```
