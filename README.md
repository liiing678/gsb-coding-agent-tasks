# roarbit

32 位整数（`0` 到 `4294967295`）上的 roaring 位图：按高 16 位分桶，桶里用「有序数组」或者
「位图」两种容器存低 16 位，再配上交集 / 并集 / 对称差和相等判断。只用 Node 标准库，`node >= 20`。

```
roarbit/
├── lib/
│   ├── roarbit.js   位图与容器逻辑（现在这版能跑，但行为跟下面《口径》对不上）   ← 待修
│   └── errors.js    RoarbitError 与全部错误码
├── test/            bitmap / ops 两组用例
├── scripts/demo.mjs 手工过一遍的演示脚本
└── package.json     npm test / npm run demo
```

```
npm test        # 15 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 值怎么分桶、怎么存

- 值的范围是 `0 .. 4294967295`（2^32 - 1）。不是整数、或者超出范围，一律 `ERR_BAD_VALUE`。
- 桶号（`key`）取高 16 位：`value >>> 16`；桶里看低 16 位：`value & 0xffff`。
- 一个桶的内容有两种容器：
  - 数组容器：把低 16 位**升序、去重**排成一个列表；
  - 位图容器：2048 个 `uint32`，正好 65536 位，低值 `v` 落在第 `v >>> 5` 个 word 的第
    `v & 31` 位上（一个 word 里低位在前）。
- 桶按 `key` 升序排；**一个值都没有的桶不留**（删空了就整个去掉）。

### 容器类型的判定

- 一个桶的值**不超过 4096 个**的时候必须是数组容器；**超过 4096 个**（也就是 4097 个起）必须是
  位图容器。正好 4096 个还是数组容器，别提前换。
- 加、删、以及集合运算之后都要重新按这条判定：数组容器涨过 4096 要换成位图容器，位图容器掉到
  4096 个或以下要换回数组容器。

### 对外的输出

- 所有吐值的接口都按数值升序。
- `toArray()` 给的是普通数组（不是 TypedArray），元素是 `0..4294967295` 的普通整数；`containers()`
  给 `[{ key, kind, count }]`，`kind` 是 `'array'` 或 `'bitmap'`，`count` 是桶里值的个数，按
  `key` 升序。
- 高位（`key >= 0x8000`，也就是值 `>= 2^31`）也要拼对，别用 `<< 16` 拼出负数或者丢掉最后一个值。

### 集合运算

- `and` 交集、`or` 并集、`xor` 对称差（两边都有的点不算对称差里的）。
- 每个桶单独算。只有一边有的桶：`or` 要带进结果，`and` 不要，`xor` 要带（那些点在另一边没有，
  正是对称差的一部分）。
- 结果里的容器类型也要按上面那条判定重新定；算出来是空桶的不要留。
- 入参一个都不许改（结果跟入参不共享底层数组）。
- 入参不是 `createBitmap()` 出来的位图 → `ERR_BAD_BITMAP`。
- `equals(a, b)`：两边点集一样才是 `true`。因为容器类型是定死的，点集一样类型必然一样，所以类型
  不一样直接 `false`。

## API

```js
import { createBitmap, and, or, xor, equals } from './lib/roarbit.js';

const bitmap = createBitmap();
bitmap.add(5);          // -> true（新加的）/ false（本来就有）
bitmap.remove(5);       // -> true（删掉了）/ false（本来没有）
bitmap.has(5);          // -> bool
bitmap.size();          // 基数
bitmap.toArray();       // 升序的普通数组
bitmap.containers();    // [{ key, kind, count }]，按 key 升序
bitmap.clone();         // 深拷贝

and(a, b);              // 新位图；or / xor 同样
equals(a, b);           // bool
```

出错一律抛 `RoarbitError`（`lib/errors.js`），按 `code` 分流：

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_VALUE` | `add` / `remove` / `has` 收的值不是 `0..4294967295` 的整数 |
| `ERR_BAD_BITMAP` | `and` / `or` / `xor` / `equals` 收的参数不是 `createBitmap()` 出来的位图 |

## demo 跑出来应该长这样

```
roarbit demo
  small.size 3
  small.toArray [1,3,70000]
  small.containers [{"key":0,"kind":"array","count":2},{"key":1,"kind":"array","count":1}]
  wide.size 5000
  wide.containers [{"key":0,"kind":"bitmap","count":5000}]
  wide.afterRemove [{"key":0,"kind":"array","count":4000}]
  and 500
  or 5500
  or.containers [{"key":0,"kind":"bitmap","count":5500}]
  xor.head [0,1,2,3]
  xor.size 5000
  equals true
  left.untouched 3000
  high.toArray [0,4294967295]
  high.has true
```
