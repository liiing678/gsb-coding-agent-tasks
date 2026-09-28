# querylite

后台那些报表以前是一条条 SQL 打到数据库上，测试环境没库、口径还老变。想在这仓库里做一个内存里跑的
查询引擎：过滤、连接、分组聚合、排序、分页，null 和类型怎么算都得跟 SQL 一个意思。
只用 Node 标准库，没有第三方包，`node >= 20`。

```
querylite/
├── lib/
│   ├── engine.js    createEngine 本体                     ← 还没实现
│   └── errors.js    QueryError 与全部错误码
├── test/            query / agg 两组用例
├── scripts/demo.mjs 手工过一遍的演示脚本
└── package.json     npm test / npm run demo
```

```
npm test        # 15 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 建库

`createEngine({ tables })`：`tables` 里每张表要么是"行数组"（列名按行里出现过的键推出来），
要么是 `{ columns, rows }`（列名显式给，空表也得有列）。每一行必须是对象，否则 `ERR_BAD_CONFIG`。

### 列引用

- **没有 join** 时，写列名就行（`'amount'`），输出的键也是列名。
- **有 join** 时，一律写 `表名.列名`（`'users.tier'`），输出的键也是 `表名.列名`；
  `join.on` 里的 `left` / `right` 例外——它们在各自那张表里找，写短名就行。
- 表名库里没有 → `ERR_UNKNOWN_TABLE`；表在库里但这次查询没参与（没 join 进来）→ `ERR_UNKNOWN_COLUMN`；
  列名在该表里没有 → `ERR_UNKNOWN_COLUMN`。

### 条件（where / having / on）

条件形如 `{ column, op, value }`，`op` 只能是
`'='` `'!='` `'<'` `'<='` `'>'` `'>='` `'in'` `'is-null'` `'not-null'`（`'in'` 用 `values` 数组）。
多个条件之间是 **AND**。

判定规则（**三值**：true / false / unknown）：

- 两边都是同一种类型（number / string / boolean）才比得动；**类型不一样，结果是 unknown**，
  所以 `userId = '1'` 不会命中数字 `1`。
- 任一边是 `null` / `undefined`，结果是 unknown（`is-null` / `not-null` 除外，它们直接判是不是空）。
- `'in'`：逐个按 `'='` 比，有一个 true 就 true；行值是 `null` 时全是 unknown，结果不通过。
- **只有 true 通过**，unknown 和不通过一样。
- `'<'` 这类大小比较不支持布尔值（unknown）。

### 连接

`join: { table, type, on: [{ left, right }] }`：

- `type` 是 `'inner'`（默认）或 `'left'`；
- `on` 至少要有一个条件，`left` 在左表（`from` 那张）里找，`right` 在右表里找，
  可选的 `op` 默认 `'='`；
- 嵌套循环：内连接只留匹配上的组合；左连接给没匹配上的左行补一行，右表的列全部是 `null`。

### 分组与聚合

`groupBy: ['列引用', ...]`、`aggregates: [{ as, fn, column, distinct }]`：

- `fn` 只能是 `'count'` `'sum'` `'avg'` `'min'` `'max'`；
- `count` 不带 `column` 数行数，带 `column` 只数非 null 的值；
- `sum` / `avg` / `min` / `max` 会**忽略 null**；`sum` / `avg` 只认数字，
  遇到非数字抛 `ERR_BAD_AGG`；`min` / `max` 只认"全是数字"或"全是字符串"，混了也抛 `ERR_BAD_AGG`；
- `distinct: true` 先去重再算（`count` 也是）；
- 取值都是空的时候 `sum` / `avg` / `min` / `max` 返回 `null`（不是 0）；
- **给了 `aggregates` 但没给 `groupBy`**：整张表算一组，**一行数据都没有也照样返回一行**
  （`count` 是 0，其余是 `null`）；
- **给了 `groupBy`**：按分组键分组，一组都没有就返回 0 行；
- 只要有 `groupBy` 或 `aggregates` 就是聚合查询，输出行 = 分组键（键名按列引用规则）+ 聚合结果（键名是 `as`），
  这种查询里 `select` 会被忽略。

### 排序、去重、分页

- `orderBy: [{ column, direction }]`，`direction` 是 `'asc'`（默认）或 `'desc'`；
  **只认输出里有的键**（投影出来的列、分组键、聚合别名），引用别的列报 `ERR_UNKNOWN_COLUMN`；
  多个排序键按顺序比，都相等时保持输入顺序（**稳定排序**）；
  `null` / `undefined` **永远排最后**（asc / desc 都一样）；两个值类型对不上抛 `ERR_BAD_QUERY`。
- `having` 也只看输出行的键，判定规则和 `where` 一样。
- `distinct: true` 按整行的值去重（列的顺序不影响）。
- 顺序固定是：**排序 → 去重 → offset → limit**。`offset` 默认 0（非负整数），
  `limit` 默认 `null`（不限，给了就得是不小于 0 的整数）。

### 输出与统计

输出是 `{ rows, stats }`：`rows` 是新的对象（行里嵌套的值只做浅拷贝，别去改传进来的对象）。
`stats` → `{ scanned, joined, filtered, groups, returned }`：
`scanned` 是 `from` 表的行数，`joined` 是连接之后的行数（没 join 就等于 `scanned`），
`filtered` 是 where 之后的行数，`groups` 是分组数（不是聚合查询就是 0），`returned` 是最终返回行数。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_CONFIG` | `tables` 不是对象、表定义不合法、行不是对象、`columns` 不合法 |
| `ERR_BAD_QUERY` | query 形状不对：`from` 缺失、条件写法不对、`select` / `groupBy` / `orderBy` 写错、`in` 没给 `values`、排序类型对不上、`limit` / `offset` 越界 |
| `ERR_UNKNOWN_TABLE` | `from` / `join.table` 这张表不存在 |
| `ERR_UNKNOWN_COLUMN` | 引用不存在的列、引用了没参与查询的表、`orderBy` / `having` 引用没输出的列 |
| `ERR_BAD_AGG` | 聚合函数不认识、`sum` / `avg` 碰到非数字、`min` / `max` 类型混、`sum` 这类没给 `column` |

## API

```js
import { createEngine, DEFAULTS, CONDITION_OPS, AGGREGATES, JOIN_TYPES } from './lib/engine.js';

const engine = createEngine({
  tables: {
    users: [{ id: 1, name: 'ann', tier: 'gold' }],
    orders: [{ id: 'o1', userId: 1, amount: 30, status: 'paid' }],
  },
});

engine.execute({
  from: 'orders',
  join: { table: 'users', type: 'left', on: [{ left: 'userId', right: 'id' }] },
  where: [{ column: 'orders.status', op: '=', value: 'paid' }],
  groupBy: ['users.tier'],
  aggregates: [{ as: 'total', fn: 'sum', column: 'orders.amount' }],
  having: [{ column: 'total', op: '>', value: 10 }],
  orderBy: [{ column: 'total', direction: 'desc' }],
  limit: 10,
});
// -> { rows: [{ 'users.tier': 'gold', total: 30 }], stats: { scanned, joined, filtered, groups, returned } }

engine.execute({ from: 'orders', select: ['id'], orderBy: [{ column: 'id' }], offset: 1, limit: 2 });
```

出错一律抛 `QueryError`（`lib/errors.js`），按 `code` 分流。

## demo 跑出来应该长这样

`npm run demo` 里数据是写死的，输出每一行都能对上：

```
querylite demo
[1] 过滤 + 投影 + 排序，null 排最后
    o2(70) o1(30) o4(5) o5(null)
[2] 类型不一样就当不知道：字符串 1 不等于数字 1
    userId='1' 命中 0 行
[3] 左连接之后按等级分组
    gold total=100 n=3
    silver total=20 n=1
    (没挂上) total=5 n=1
[4] 换成内连接，再用 having 砍掉小分组
    gold total=100
[5] 统计
    {"scanned":5,"joined":5,"filtered":5,"groups":3,"returned":3}
```
