# routegraph

排班系统里要算「最早几点能到」：一张有向图，边上可能带封路时间窗，路口上还可能挂着转弯限制。
只按下面的口径来，只用 Node 标准库，`node >= 20`。

```
routegraph/
├── lib/
│   ├── routegraph.js  createRouter 与最早到达计算            ← 还没实现
│   └── errors.js      RouteError 与错误码
├── test/              route / edge 两组用例
├── scripts/demo.mjs   手工过一遍的演示脚本
└── package.json       npm test / npm run demo
```

```
npm test        # 13 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 图怎么给

`createRouter({ nodes, edges, turns })`：

- `nodes` 是节点名，非空字符串，不许重复。边是**有向**的，只按 `from → to` 走；
  同一对节点之间可以有好几条边。
- `edges` 每条 `{ id, from, to, length, speed, closures }`。`id` 非空且不重复；`from` / `to` 得是声明过的节点
  （不然 `ERR_UNKNOWN_NODE`，`details.edge` 是这条边的 id）；`length` / `speed` 都是**正数**（有限），
  走一条边花 `length / speed` 秒，可以是小数。`closures` 见下，不写就是空数组。
- `turns` 每条 `{ from, via, to, kind }`：`from` / `to` 是边 id，`via` 是个节点，`kind` 只有 `'no'` / `'only'`。

### 代价与状态

- 代价就是**到达时刻**（秒，实数）。`route({ from, to, departAt = 0 })` 返回 `{ arrive, seconds, path }`：
  `path` 是边 id 的顺序，`seconds` 就是 `arrive - departAt` —— 包括在路上干等的那些时间。
  去不了返回 `null`。
- 状态不是「到了哪个节点」，而是「**从哪条边过来的**」：同一个路口带着不同的入边是两回事，
  因为转弯限制要看上一条边。
- `from === to` 直接给 `{ arrive: departAt, seconds: 0, path: [] }`：零条边，封路和转弯都不看。

### 封路时间窗

- `closures` 是 `[[开始, 结束], ...]`，单位是**当天的秒**：`0` 是零点，`86400` 是当天结束。
- 区间**左闭右开**：开始那一刻进不去，结束那一刻就能进了。
- `开始 > 结束` 表示**跨零点**，`[[86000, 100]]` 就是「23:53:20 封到第二天 00:01:40」。
- `开始 === 结束` 是**整天封**；`[0, 86400]` 也一样是整天封。
- 到了边上发现封着，就在路口**干等到这段封路结束**再走（不绕道，也不按原速往前挪）。几段连着就一路等：
  从命中的那段往后跳，跳完再看一遍，直到不在任何区间里为止。
- `departAt` 可以超过 86400，按 `departAt % 86400` 折回当天的秒来判。
- 一条边整天封着，那它就永远用不了；`route` 会绕别的路，实在没别的路就是 `null`。

### 转弯限制

- `{ from, via, to, kind: 'no' }`：不许「走完 `from`、在 `via` 路口拐上 `to`」。
- `{ from, via, to, kind: 'only' }`：走完 `from` 到 `via` 之后**只准**接 `to`。同一个 `from` + `via` 上写了多条
  `only` 就是这几条都能走；`no` 和 `only` 叠加时 `no` 优先否掉。
- **从起点迈出去的第一条边不受任何限制管**：它前面没有边。
- `via` 得是 `from` 那条边的终点，否则这条限制永远用不上（不报错，就是挂着好看）。
- 掉头（走完 `ab` 到 `B` 再接 `ba`）不做特殊处理，想禁就自己写一条 `no`。

### 并列怎么选

先比到达时刻，小的赢；到达时刻一样就比 `path` 的边 id 序列**字典序**（前缀更短的更小，
`['a1']` 比 `['a1', 'a2']` 小、`['a1', 'a2']` 比 `['z9']` 小）。

### 出错的地方

| 错误码 | 什么时候抛 | `details` |
|---|---|---|
| `ERR_BAD_ARGUMENT` | `data` 不是普通对象；`nodes` / `edges` / `turns` 不是数组；节点不是非空字符串或重复；边不是对象、`id` 空或重复、`length` / `speed` 不是正数；`closures` 不是数组或某项不是两个 `0..86400` 的有限数；转弯限制不是对象、`kind` 不是 `no` / `only`；`route` 的参数不是普通对象、`departAt` 不是 ≥ 0 的有限数 | `{}` |
| `ERR_UNKNOWN_NODE` | 边引用了没声明的节点；转弯限制引用了不存在的边、或 `via` 不是节点；`route` 的 `from` / `to` 不是节点 | `{ edge }` / `{ node }` |

## API

| 入口 | 说明 |
|---|---|
| `createRouter({ nodes, edges, turns = [] })` | 建图；建的时候就校验，不合法直接抛 |
| `route({ from, to, departAt = 0 })` | `{ arrive, seconds, path }` 或 `null` |
| `edges()` | 所有边的快照，每条带算出来的 `seconds` 和 `closures` 的拷贝 —— 改它动不了内部 |
| `stats()` | `{ nodes, edges, turns }` |

`route` 返回的 `path` 一定走得通（每条边的 `from` 都接得上上一条边的 `to`）、一定不违反转弯限制。
同一个 router 反复问同一个问题，答案（连 `path`）得一模一样。

## demo 跑出来应该长这样

```
routegraph demo
  stats {"nodes":4,"edges":5,"turns":0}
  basic {"arrive":2,"seconds":2,"path":["e1","e3"]}
  same {"arrive":5,"seconds":0,"path":[]}
  closure {"arrive":92,"seconds":2,"path":["e1","e3"]}
  wrap {"arrive":86501,"seconds":201,"path":["x"]}
  sealed {"arrive":6,"seconds":6,"path":["y","z"]}
  no-turn {"arrive":5,"seconds":5,"path":["ac"]}
  only-turn {"arrive":4,"seconds":4,"path":["ad"]}
  tie {"arrive":2,"seconds":2,"path":["a1"]}
  unreachable null
  missing-node ERR_UNKNOWN_NODE
```