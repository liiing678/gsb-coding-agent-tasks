# typemap

输入框下面的补全要自己实现：一份压缩前缀树（边带标签的 radix tree），支持按前缀取 top-k、
按编辑距离模糊找近义词、删除之后能把树收回去。只用 Node 标准库，`node >= 20`。

```
typemap/
├── lib/
│   ├── typemap.js   createIndex 与插入 / 删除 / 查询              ← 还没实现
│   └── errors.js    IndexError 与错误码
├── test/            trie / edge 两组用例
├── scripts/demo.mjs 手工过一遍的演示脚本
└── package.json     npm test / npm run demo
```

```
npm test        # 11 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 词、权重、排序

- 词是非空字符串，**一切按 UTF-16 码元算**（`'😀'.length` 是 2，一个 emoji 在编辑距离里算两个码元）。
- 权重是有限数字，可以是 `0` 或负数；不传就是 `1`。
- `prefix` / `top` / `fuzzy` 都返回 `[{ term, weight }]`。排序：**权重降序**，权重一样时**词条按码元升序**；
  `fuzzy` 在最前面多一层**编辑距离升序**。

### 压缩前缀树与 stats

- 树是边带标签的：一条边代表一串字符，不是单个字符。
- `stats()` 返回 `{ terms, nodes }`。`nodes` 只数**根、词尾、岔路口（儿子 ≥ 2）**这三种位置的节点，
  中间那些直溜溜的节点没有实体。空表是 `{ terms: 0, nodes: 1 }`。
- 删除要真的把结构收回去：词尾标记去掉以后，如果它一个儿子都没有就直接摘掉，只有一个儿子就并回父边，
  一路往上递归 —— 所以删掉一个词再插回来，`stats()` 必须跟原来一模一样。

### prefix

- `prefix(prefix, limit = 10)`：返回所有以它打头的词。`prefix` 是空串就等于 `top`。
- 前缀正好停在**某条边标签的半截**上时（比如树里有 `card`、边标签是 `car`，查 `ca`），整棵子树都命中。

### fuzzy

- 编辑距离是 Levenshtein：插入、删除、替换各算 1，按码元比。
- `fuzzy(term, maxDistance, limit = 10, options = {})` 只收距离 ≤ `maxDistance` 的词。
- 访问预算 `options.maxVisits`，默认 `20000`。从根开始、每个节点的儿子**按边标签的码元升序**往下走
  （深度优先），**进一个节点算一次访问（根也算）**；走到某个节点时如果 DP 行的最小值已经大于
  `maxDistance`，这棵子树就**不许再进**（这一步不是可选的，预算按这个算）。
  访问数超过 `maxVisits` 立刻抛 `ERR_BUDGET_EXCEEDED`，`details.visits` 是当时已经访问的节点数。

### 出错的地方

| 错误码 | 什么时候抛 | `details` |
|---|---|---|
| `ERR_BAD_ARGUMENT` | 词不是字符串或是空串；权重不是有限数字；`limit` / `maxDistance` 不是非负整数；`options` 不是普通对象；`maxVisits` 不是正整数；`entries` 不是数组或某一笔不是词 / `[词, 权重]` | `{}` |
| `ERR_BUDGET_EXCEEDED` | `fuzzy` 的访问数超过 `maxVisits` | `{ visits }` |

## API

| 入口 | 说明 |
|---|---|
| `createIndex(entries = [])` | 建索引；`entries` 每一笔要么是词（权重 1），要么是 `[词, 权重]` |
| `insert(term, weight = 1)` | 新词返回 `true`，已有的词改权重返回 `false` |
| `remove(term)` | 删掉了返回 `true`，本来就没有返回 `false` |
| `has(term)` / `weight(term)` | 在不在 / 权重（没有是 `null`） |
| `prefix(prefix, limit = 10)` | 以 `prefix` 打头的词，按排序规则取前 `limit` 个 |
| `fuzzy(term, maxDistance, limit = 10, { maxVisits = 20000 })` | 编辑距离在 `maxDistance` 以内的词 |
| `top(limit = 10)` | 全表 top-k |
| `stats()` | `{ terms, nodes }` |

## demo 跑出来应该长这样

```
typemap demo
  stats {"terms":6,"nodes":8}
  prefix-c [{"term":"card","weight":9},{"term":"cat","weight":5},{"term":"car","weight":3}]
  prefix-car [{"term":"card","weight":9},{"term":"car","weight":3}]
  prefix-z []
  top-2 [{"term":"card","weight":9},{"term":"cat","weight":5}]
  fuzzy-cot-2 [{"term":"cat","weight":5},{"term":"dot","weight":1},{"term":"car","weight":3}]
  fuzzy-cat-0 [{"term":"cat","weight":5}]
  remove-card true
  after-remove [{"term":"cat","weight":5},{"term":"car","weight":3}]
  stats {"terms":5,"nodes":7}
  reinsert-card true
  stats {"terms":6,"nodes":8}
  budget ERR_BUDGET_EXCEEDED {"visits":3}
```
