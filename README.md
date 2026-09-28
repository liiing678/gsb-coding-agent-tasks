# avlmap

自平衡有序表：整数键 + 任意值，按 `(key)` 升序排队，接口里带 0 基名次、下选取值与闭区间范围。
只用 Node 标准库，`node >= 20`。

```
avlmap/
├── lib/
│   ├── avlmap.js   createMap / AvlMap 的增删查与名次接口
│   └── errors.js   AvlError 与错误码
├── test/           map / order 两组用例
├── scripts/demo.mjs 手工过一遍的演示脚本
└── package.json    npm test / npm run demo
```

```
npm test        # 12 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 数据与不变式

- 键必须是**安全整数**（`Number.isSafeInteger` 为真），值随便放（`undefined` 也算放过了，
  想知道有没有这个键用 `has`）。键就是主键，重复 `set` 只换值、不新增。
- 表里按**键升序**排；`entries()` / `range()` / `at()` / `indexOf()` 都按这个顺序来。
- 结构上是一棵**平衡二叉搜索树**：任意节点左右子树的高度差不超过 1，而且每次插入 / 删除之后
  都要转回来。`height()` 的定义：空表 `0`，只有一个节点 `1`，其余是根到最远叶子的节点数。
  4096 个节点的时候高度要到 13 以内（判定用 `h <= 1.4405 * log2(n + 2) - 0.3277` 取整这条件），
  按 1..n 递增插入也一样 —— 递增插入退化成链就是没转。

### 接口

- `set(key, value)`：放进去了，或者把老键的值换掉；返回表自己（可以链着写）。
- `get(key)`：值；没有这个键是 `undefined`。`has(key)`：有没有。
- `remove(key)`：**删掉了返回 `true`**，本来就没有返回 `false`（这时候树一点都别动）。
- `size()` 是当前键的个数，`clear()` 清空（清完 `size()` 是 0、`height()` 是 0）。
- `min()` / `max()`：`[key, value]`，空表是 `null`。
- `at(index)`：0 基升序第 `index` 个 `[key, value]`；下标越界（含负数）返回 `null`；
  下标不是整数是 `ERR_BAD_ARGUMENT`。
- `indexOf(key)`：这个键的 0 基升序名次；没这个键返回 `-1`。
- `range(from, to)`：`from <= key <= to` 的所有记录（**闭区间**），升序；`from > to` 就是 `[]`。
- `entries()`：`[[key, value], ...]` 升序。返回的数组都是新的，改它不影响表。
- `stats()`：`{ nodes, height, visited }`。`nodes` 是键的个数、`height` 就是 `height()`，
  `visited` 是**最近一次 `at` / `indexOf` 摸过的节点数**（这两个入口一进去就清零）。
  名次查询要顺着子树大小往下走，`visited` 不许超过当前树高。

### 出错的地方

| 错误码 | 什么时候抛 |
|---|---|
| `ERR_BAD_ARGUMENT` | 键不是安全整数（`1.5`、`NaN`、`Infinity`、`'1'`、`null`、`2 ** 53`、大整数……），`at` 的下标不是整数 |

## API

| 入口 | 说明 |
|---|---|
| `createMap()` | 建一张空表 |
| `set(key, value)` | 放入 / 覆盖 |
| `get(key)` / `has(key)` | 取值 / 查在不在 |
| `remove(key)` | 删掉 `true` / 本来没有 `false` |
| `size()` / `clear()` | 个数 / 清空 |
| `min()` / `max()` | 最小 / 最大的 `[key, value]`，空表 `null` |
| `at(index)` / `indexOf(key)` | 0 基下选取值 / 0 基名次 |
| `range(from, to)` / `entries()` | 闭区间 / 全部，升序 |
| `height()` / `stats()` | 树高 / `{ nodes, height, visited }` |

## demo 跑出来应该长这样

```
avlmap demo
  size 10
  height 4
  entries [[1,"v1"],[2,"v2"],[3,"v3"],[4,"v4"],[5,"v5"],[6,"v6"],[7,"v7"],[8,"v8"],[9,"v9"],[10,"v10"]]
  min [1,"v1"]
  max [10,"v10"]
  at.3 [4,"v4"]
  indexOf.7 6
  indexOf.99 -1
  range.3.7 [[3,"v3"],[4,"v4"],[5,"v5"],[6,"v6"],[7,"v7"]]
  remove.5 true
  remove.5.again false
  size.after 9
  height.after 4
  increasing.height 13
  increasing.stats {"nodes":4096,"height":13,"visited":0}
  badKey.code ERR_BAD_ARGUMENT
```