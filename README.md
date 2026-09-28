# jsonpatch

JSON 文档的指针、patch（RFC 6902 那一套）、merge patch、从两份文档里生成 patch，还有把 patch 反过来。
只用 Node 标准库，没有第三方包，`node >= 20`。

```
jsonpatch/
├── lib/
│   ├── jsonpatch.js   parsePointer / get / apply / diff / mergePatch / invert   ← 还没实现
│   └── errors.js      JsonpatchError 与全部错误码
├── test/              pointer / patch / diff 三组用例
├── scripts/demo.mjs   手工过一遍的演示脚本
└── package.json       npm test / npm run demo
```

```
npm test        # 12 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 指针

- `parsePointer(text)`：`''` 就是整个文档（空数组）；别的必须以 `/` 开头，不然报 `ERR_BAD_POINTER`。
  每个 `/` 之间是一段：`~1` 还原成 `/`、`~0` 还原成 `~`，**从左往右一个字符一个字符地看**
  （所以 `~01` 还原出来是 `~1`）；`~` 后面不是 `0` 或 `1`（包括末尾孤零零一个 `~`）报
  `ERR_BAD_POINTER`。
- `formatPointer(tokens)`：`tokens` 是字符串或非负整数组成的数组，先把每段里的 `~` 换成 `~0`、
  再把 `/` 换成 `~1`（**顺序不能反**），然后拼成 `/段/段`；空数组拼出来是 `''`。
- 数组下标只认 `0` 或者不以 `0` 开头的十进制（`01`、`-0`、`1.0`、`x` 都是不合法的指针，
  报 `ERR_BAD_POINTER`）。`-` 表示「末尾」，只有在 `add` 的路径最后一段上才算数，
  别的地方（`get` / `remove` / `replace` / `test` / `move` 的目标）一律当**不存在**（报 `ERR_PATH_MISSING`）。
- `get(doc, pointer)` 取不到就报 `ERR_PATH_MISSING`：路径中间不存在、数组下标越界、
  想在字符串上取键，都算取不到。

### apply

`apply(doc, patch)` 返回**新文档**，原文档一个字节都不许改（深拷贝）。整条 patch 是**原子**的：
中间任何一条失败就抛错，原文档还是原样。出错时 `err.details.index` 是第几条出的问题（从 0 数）。

`patch` 是操作数组，每条是 `{ op, path, ... }`，`path` 都是指针字符串：

- `add`：对象上就是加或者覆盖（**新键追加在对象最后**，覆盖已有的键位置不动）；
  数组上插到该下标（`-` 或者等于长度的下标就是追加到末尾，比长度大报 `ERR_PATH_MISSING`）。
  `path` 是空指针时，整份文档换成 `value`。
- `remove`：对象上键得存在，数组上下标得存在（`-` 不算）；数组删掉之后后面的往前挪。
  空指针上不能删，报 `ERR_BAD_PATCH`。
- `replace`：路径必须**已经存在**（对象键存在 / 数组下标在范围内），空指针就是整份文档换掉。
- `move`：`from` 必须取得到。`from` 是 `path` 的**严格前缀**时报 `ERR_BAD_PATCH`
  （那样等于往自己里面塞）；两者一样就什么都不干。别的情况就是先删再插。
- `copy`：从 `from` 深拷贝一份，再按 `add` 的规则放到 `path`。
- `test`：路径取不到报 `ERR_PATH_MISSING`；取到了但和 `value` 深度对不上报 `ERR_TEST_FAILED`。
- 别的 `op`、缺 `path` / `from` / `value`、`path` 不是合法指针，都报 `ERR_BAD_PATCH`。

深度相等（`test`、`diff`、`equals` 都用它）：数组看长度和顺序，对象**不看键的顺序**，
基本类型按 `Object.is` 比（`NaN` 和 `NaN` 算相等）。

### diff

`diff(a, b)` 出一串能用 `apply(a, ...)` 还原成 `b` 的 patch（这条性质用例会全面检查）。

- 两边深相等 → `[]`。
- 都是对象：`a` 里有、`b` 里没有的键先出一条 `remove`；然后按 `b` 的键顺序，
  新键出 `add`，共有的键递归比下去（路径接在这条键后面）。**键的顺序变了不算差异**。
- 都是数组：先拿**最长公共子序列**（元素深相等才算相等）挑出两边的保留元素，
  `a` 里没保留的按**下标从大到小** `remove`，`b` 里没保留的按**下标从小到大** `add`；
  `add` 的下标是「在删完之后的数组里、已经摆好的位置数」。
  LCS 的并列怎么破要钉死：用标准的 `dp[i][j]`（`a[i..]` 和 `b[j..]` 的最长公共长度），
  从前往后扫，`a[i]` 和 `b[j]` 深相等就一起留下来；否则比 `dp[i+1][j]` 和 `dp[i][j+1]`，
  **相等时算放弃 `a[i]`**（也就是先删）。
- 一个是对象一个是数组、或者类型不一样：一条 `{ op: 'replace', path, value }`。

### mergePatch

`mergePatch(target, patchDoc)` 也返回新文档：

- `patchDoc` 不是对象（包括 `null`、数组、字符串）→ 整份换成 `patchDoc` 的深拷贝；
- 是对象 → 值为 `null` 就把这个键**删掉**，值是对象且 `target` 对应的值也是对象就递归合并，
  其它情况直接换成这份拷贝；`target` 不是对象时当空对象处理。
- 数组一律整体替换，不按下标合并。

### invert

`invert(patch, doc)`（`doc` 是 patch **还没应用**的文档）返回一条能把它还原回去的反向 patch。
它自己会拿着 `doc` 从前往后把整条 patch 走一遍（`test` 也得过），所以每条操作要用的旧值都是
**那一刻**文档上的值，不是最开始的 `doc` 上的值：

- 反向 patch 的顺序是**原 patch 倒过来**；
- `remove` → 反向 `add` 回原值；`replace` → 反向 `replace` 成原值；
  `move` → 反向 `{ op: 'move', from: 原 path, path: 原 from }`；
- `add` / `copy`：目标路径的父是数组 → 反向 `remove`（插入的那个下标）；
  父是对象、`doc` 上这个键本来就有 → 反向 `replace` 成原值，本来没有 → 反向 `remove`；
- `test` 不产生反向操作。

## API

```js
import {
  parsePointer, formatPointer, get, apply, diff, mergePatch, invert, equals,
} from './lib/jsonpatch.js';

const doc = { a: { b: [1, 2, 3] }, keep: true };

parsePointer('/a/b/0');       // -> ['a', 'b', '0']
formatPointer(['a', 'b~c']);  // -> '/a/b~0c'
get(doc, '/a/b/1');           // -> 2

apply(doc, [{ op: 'add', path: '/a/b/-', value: 4 }]);
// -> 新文档（doc 本身没变）

diff(doc, { a: { b: [1, 3] }, keep: true });
// -> [{ op: 'remove', path: '/a/b/1' }]

mergePatch({ a: 1, b: 2 }, { b: null, c: 3 });  // -> { a: 1, c: 3 }
invert([{ op: 'add', path: '/x', value: 1 }], {});  // -> [{ op: 'remove', path: '/x' }]
```

出错一律抛 `JsonpatchError`（`lib/errors.js`），按 `code` 分流：

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_POINTER` | 指针不是字符串、不是以 `/` 开头、`~` 转义不合法、数组下标写得不像下标 |
| `ERR_PATH_MISSING` | 路径取不到：中间不存在、下标越界、在非对象上取键、`-` 用在了不该用的地方、`add` 到数组越界 |
| `ERR_BAD_PATCH` | patch 不是数组、`op` 不认识、该有的 `path` / `from` / `value` 没给、空指针上做 `remove`、`move` 的 `from` 是 `path` 的前缀 |
| `ERR_TEST_FAILED` | `test` 对不上 |

## demo 跑出来应该长这样

```
jsonpatch demo
  pointer /tags/1
  get "b"
  diff [{"op":"remove","path":"/tags/1"},{"op":"add","path":"/tags/2","value":"d"},{"op":"remove","path":"/meta/drop"},{"op":"replace","path":"/meta/keep","value":false},{"op":"add","path":"/extra","value":7}]
  applied {"name":"demo","tags":["a","c","d"],"meta":{"keep":false},"extra":7}
  roundtrip true
  inverted true
  untouched {"name":"demo","tags":["a","b","c"],"meta":{"keep":true,"drop":1}}
  merge {"a":{"x":1,"y":2}}
  mergeArray {"list":[3]}
  badTest ERR_TEST_FAILED@1
  badPointer ERR_BAD_POINTER@0
  missing ERR_PATH_MISSING@0
```
