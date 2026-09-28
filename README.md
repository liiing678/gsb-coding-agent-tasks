# skipzset

有序集合：成员按（分数升序，成员升序）排队，支持名次、下标区间、分数区间与字典序区间查询。
只用 Node 标准库，`node >= 20`。

```
skipzset/
├── lib/
│   ├── skipzset.js   createZset 与 Zset 的全部方法     ← 还没实现
│   └── errors.js     ZsetError 与错误码
├── test/             zset / query 两组用例
├── scripts/demo.mjs  手工过一遍的演示脚本
└── package.json      npm test / npm run demo
```

```
npm test        # 11 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 一条记录

集合里每一条是 `{ member, score }`：

- `member` 必须是**非空字符串**；
- `score` 必须是**有限数字**（`NaN`、`Infinity`、`-Infinity` 都不收）；
- 顺序是**分数升序**，分数一样的按**成员升序**；成员之间就按 JS 字符串那套比较（`<` / `>`，
  也就是 UTF-16 码元序，`'a'` 排在 `'B'` 后面）。分数和成员都相同是不可能的（成员是主键）。

### 写

- `add(member, score)`：**新成员返回 1**，**老成员返回 0**（分数一样也返回 0），分数以最后一次为准。
  改完分数之后它在集合里的位置、以及所有人的名次都要跟着变。
- `remove(member)`：删掉了返回 1，本来就没有返回 0。
- `clear()`：清空。

### 读

- `score(member)`：分数，没有就是 `null`。
- `size()`：成员个数。
- `rank(member)`：**0 基**的升序名次；`revRank(member)` 是从分数最大那头数的 0 基名次；
  没有这个成员就是 `null`。
- `range(start, stop)`：0 基的**闭区间**，支持负下标（`-1` 是最后一个，`-2` 是倒数第二个）。
  先把负数各自 `+ size` 换算成正下标，再把两端截到 `[0, size - 1]`；之后如果集合是空的、
  或者 `start > stop`、或者 `start` 已经越过尾部，就返回 `[]`。例：5 个成员时 `range(-99, 99)`
  是全部，`range(1, -2)` 是第 2 个到倒数第 2 个，`range(-1, -3)` 是 `[]`。
- `rangeByScore(min, max)`：分数**闭区间**，两端都可以用 `±Infinity`；`min > max` 返回 `[]`。
- `countByScore(min, max)`：就是上面那个区间里的成员个数。
- `rangeByLex(min, max)`：**只看成员**、跟分数没有关系，返回的成员按成员升序排。区间两端写成
  字符串：`'-'` 表示最小、`'+'` 表示最大、`'[x'` 是含端点 `x`、`'(x'` 是不含端点 `x`
  （`'['` / `'('` 后面跟着空串也算合法，表示空字符串这个端点）。
- `entries()`：`[[member, score], ...]`，按同样的升序。

几条查询返回的数组都是**新数组**，改它不会动到集合内部。

### 错误码

| 错误码 | 什么时候抛 |
|---|---|
| `ERR_BAD_ARGUMENT` | `member` 不是非空字符串、`score` 不是有限数字、`range` 的下标不是整数、`rangeByScore` / `countByScore` 的边界不是数字（`NaN` 不行，`±Infinity` 行）、`rangeByLex` 的边界不是字符串 |
| `ERR_BAD_BOUND` | `rangeByLex` 的边界不是 `'-'`、`'+'`、`'[值'`、`'(值'` 这四种写法（空字符串、`'b'`、数字……） |

## API

| 入口 | 说明 |
|---|---|
| `createZset()` | 建一个空的有序集合，返回的对象带下面的方法 |
| `add(member, score)` | 新增 1 / 更新 0 |
| `remove(member)` | 删掉 1 / 没有 0 |
| `score(member)` | 分数或 `null` |
| `size()` | 成员个数 |
| `rank(member)` / `revRank(member)` | 0 基名次或 `null` |
| `range(start, stop)` | 下标区间（闭区间、支持负数） |
| `rangeByScore(min, max)` / `countByScore(min, max)` | 分数区间 / 区间计数 |
| `rangeByLex(min, max)` | 字典序区间 |
| `entries()` | 全部记录，升序 |
| `clear()` | 清空 |

## demo 跑出来应该长这样

```
skipzset demo
  add.fig 1
  add.apple 1
  add.pear 1
  add.date 1
  again.pear 0
  size 4
  entries [["fig",1],["apple",2],["pear",2],["date",5]]
  range.0.-1 ["fig","apple","pear","date"]
  range.1.2 ["apple","pear"]
  rank.pear 2
  revRank.pear 1
  score.missing null
  byScore.2.5 ["apple","pear","date"]
  count.2.5 3
  byLex.b.d []
  byLex.afterCherry ["date","fig","pear"]
  remove.date 1
  size.after 3
  badMember.code ERR_BAD_ARGUMENT
  badBound.code ERR_BAD_BOUND
```