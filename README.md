# vclock

点版本向量（dotted version vector）：把「谁见过哪些事件」记成一个个 dot（`id` 加一个计数），
用来比较两个副本谁走在前面、合并、以及按因果关系投递消息 —— 前置没到齐的消息先挂起来，
到齐了再一起并进来。只用 Node 标准库，`node >= 20`。

```
vclock/
├── lib/
│   ├── vclock.js   时钟的规范化 / tick / merge / compare / dots / contains / missing
│   │                 和因果投递节点 createNode          ← 还没实现
│   └── errors.js    VclockError 与全部错误码
├── test/            vclock / delivery 两组用例
├── scripts/demo.mjs 手工过一遍的演示脚本
└── package.json     npm test / npm run demo
```

```
npm test        # 12 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 时钟长什么样

一份时钟是若干个「同一个 id 上连续的一段计数」，每段 `{ id, from, to }`：

- `id` 非空字符串；`from` / `to` 都是 `>= 1` 的整数，而且 `from <= to`。
  这一段表示 `from`、`from + 1` …… `to` 这些 **dot**。
- **规范化**就是下面这个形状（`tick` / `merge` 吐出来的都是它，所有入口也要求收到的是它）：
  1. 各段按 `id` 升序排（就是 JS 里字符串的 `<`）；同一个 `id` 内部按 `from` 升序；
  2. 同一个 `id` 上**相邻的两段必须并成一段** —— 前一段的 `to` 加一正好等于后一段的 `from`
     的，要合成一段；
  3. 长度小于 1 的段不存在（`from > to` 的段直接丢掉）。
- 实战里同一个 id 上的点是 `1..顶` 连着的一段（`tick` 只在顶上再加一个，`merge` 只取并集），
  但**规则上允许有洞**：`[{ id: 'a', from: 1, to: 2 }, { id: 'a', from: 4, to: 5 }]` 是合法形状
  （点集是 `a:1 a:2 a:4 a:5`）。所以凡是跟「点」有关的地方（`compare` / `contains` /
  `missing` / 投递的前置判断）一律按真正的点集算，**别拿某个 id 的顶当整个点集用**。

### tick / merge

- `tick(clock, id)`：把这个 id 的顶加一，得到新点 `顶 + 1`，规范化的时候自然会跟它下面那段
  并起来。`[{a:1..2}]` tick 一次是 `[{a:1..3}]`；空时钟 tick 一次是 `[{a:1..1}]`；别的 id 一点不动。
- `merge(...clocks)`：每个参数都必须是**已经规范化的时钟**，不是就抛 `ERR_BAD_CLOCK`
  （别顺手帮人收拾形状）；结果是所有点的**并集**（不是把计数加起来），再规范化一遍。
  `merge()` 一个参数都没有就是空时钟。

### 比较与查点

- `compare(left, right)` 比的是**点的集合**，返回四种之一：
  - `'equal'`：两边点集一模一样；
  - `'before'`：left 的每个点 right 都有，而且 right 还多；
  - `'after'`：反过来；
  - `'concurrent'`：两边各有对方没有的点。
  注意 `[{a:1..3}]` 和 `[{a:1..2}, {a:4}]` 是 `'concurrent'`，虽然两边的顶都是 3。
- `dots(clock)`：把所有点展开成 `{ id, counter }`，顺序是「先按 id 升序，同一个 id 里计数从小到大」。
- `contains(clock, dot)`：这个点在不在时钟里。
- `missing(clock, other)`：**other 有而 clock 没有**的点，按 `dots(other)` 的顺序，每项是字符串
  `'id:计数'`（就是 `dots` 里那个 `{ id, counter }` 写成 `id:counter`）。

### 因果投递

`createNode(id)` 起一个副本（`id` 不是非空字符串就抛 `ERR_BAD_CLOCK`），它带自己的时钟和一个
**挂起队列**：

- `node.id`、`node.clock()`、`node.pending()`（后两个都返回快照副本）。
- `node.send(payload)`：先把自己的时钟 `tick` 一次，再返回消息 `{ from: id, payload, clock }`，
  里面的 `clock` 是 tick 之后的快照。
- `node.deliver(message)`：见下，返回布尔。

消息长这样：`{ from, payload, clock }`。`from` 非空字符串；要有 `payload` 字段（值随便，
`undefined` 也算有）；`clock` 必须是规范化的时钟，而且**里面要有 `from` 自己的点**（顶至少是 1）。
消息自己的那个点就是 `{ id: from, counter: 消息 clock 里 from 的顶 }`。形状不对一律抛
`ERR_BAD_MESSAGE`，注意这里**不是** `ERR_BAD_CLOCK`。

`deliver` 的规则：

1. 消息形状不对 → 抛 `ERR_BAD_MESSAGE`。
2. 重复 → 返回 `false`，而且不重复入队。算重复有两条：自己的点已经在节点时钟里；或者挂起队列里
   已经有一条同 `from` 同计数的消息。
3. 前置齐不齐：看这条消息的 `clock` 里，**除了它自己的那个点**，其余的点是不是已经都在本节点时钟里。
   齐 → 把它并进时钟（就是 `merge`），再顺手把挂起队列里因此变齐的消息依次并进来，返回 `true`。
4. 不齐 → 塞进挂起队列，返回 `false`。

挂起队列保持加入顺序，`pending()` 就给这个顺序。扫描时从头到尾扫一遍，扫到谁前置齐了就并进去；
只要这一遍并进过东西，就再从头扫一遍，直到整遍下来一个都没动。所以挂起的先后不影响最后的结果。

## API

```js
import {
  empty, tick, merge, compare, dots, contains, missing, createNode,
} from './lib/vclock.js';

empty();                                    // -> []
tick(empty(), 'a');                         // -> [{ id: 'a', from: 1, to: 1 }]
tick(tick(empty(), 'a'), 'a');              // -> [{ id: 'a', from: 1, to: 2 }]
merge([{ id: 'a', from: 1, to: 2 }], [{ id: 'a', from: 3, to: 3 }]);
                                            // -> [{ id: 'a', from: 1, to: 3 }]
compare(a1, a2);                            // -> 'before' | 'after' | 'equal' | 'concurrent'
dots(clock);                                // -> [{ id: 'a', counter: 1 }, ...]
contains(clock, { id: 'a', counter: 2 });   // -> true / false
missing(empty(), clock);                    // -> ['a:1', 'a:2', 'b:1']

const a = createNode('a');
const m1 = a.send('a1');                    // -> { from: 'a', payload: 'a1', clock: [...] }
a.clock();                                  // 发送之后的时钟
a.pending();                                // 现在挂着哪些消息

const b = createNode('b');
b.deliver(m1);                              // -> true（并进时钟了） / false（挂起或重复）
```

出错一律抛 `VclockError`（`lib/errors.js`），按 `code` 分流：

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_CLOCK` | 时钟不是规范化的形状（不是数组、段不是对象、`id` 不是非空字符串、`from` / `to` 不是正整数、`from > to`、同一个 id 上相邻的两段没并、各段没按 id 升序）；`tick` / `createNode` 的 `id` 不是非空字符串 |
| `ERR_BAD_DOT` | `contains` 收的 dot 不是 `{ id: 非空字符串, counter: 正整数 }` |
| `ERR_BAD_MESSAGE` | `deliver` 收的不是对象、`from` 不是非空字符串、没有 `payload` 字段、`clock` 不是规范化的时钟、或者 `clock` 里没有 `from` 自己的点 |

## demo 跑出来应该长这样

```
vclock demo
  empty []
  a.clock [{"id":"a","from":1,"to":2}]
  m2 {"from":"a","payload":"a2","clock":[{"id":"a","from":1,"to":2}]}
  b.deliver(m2) false
  b.pending 1
  b.deliver(m1) true
  b.clock [{"id":"a","from":1,"to":2}]
  b.pendingAfter 0
  b.deliver(m2)again false
  compareAB equal
  c.clock [{"id":"a","from":1,"to":2},{"id":"c","from":1,"to":1}]
  compareBC before
  missingBC ["c:1"]
  dotsC ["a:1","a:2","c:1"]
  mergeBC [{"id":"a","from":1,"to":2},{"id":"c","from":1,"to":1}]
  tickA [{"id":"a","from":1,"to":3}]
  compareCD concurrent
  c.deliver(m4) true
  c.clockAfter [{"id":"a","from":1,"to":2},{"id":"c","from":1,"to":1},{"id":"d","from":1,"to":1}]
  b.deliver(m3) true
  b.clockAfter [{"id":"a","from":1,"to":2},{"id":"c","from":1,"to":1}]
```
