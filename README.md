# flagr

灰度开关服务端那部分：开关定义、按用户分桶放量、规则优先、开关之间互相依赖，
改配置的时候还得保证老用户不被洗牌。只用 Node 标准库，没有第三方包，`node >= 20`。

```
flagr/
├── lib/
│   ├── flagr.js   createFlagEngine 本体                ← 还没实现
│   └── errors.js  FlagError 与全部错误码
├── test/          evaluate / rules 两组用例
├── scripts/demo.mjs  手工过一遍的演示脚本
└── package.json   npm test / npm run demo
```

```
npm test        # 15 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 开关定义

`defineFlag({ key, variations, offVariation, rules, rollout, requires })`：

- `key` 非空字符串，不能重复定义；重复 → `ERR_DUPLICATE_FLAG`。
- `variations` 是非空、互不重复的名字数组。
- `offVariation`：关掉时（或者没规则没灰度时）serve 的那个，必须是 `variations` 里的一个或 `null`。
- `rules`：见下；`rollout`：见下；`requires`：见下。

返回 `{ key, version }`，新定义的 `version` 是 1；`updateFlag` 用同一套校验，
成功之后 `version` 加一；`removeFlag({ key })` 返回 `{ key, removed: true }`，
开关还被别人的 `requires` 指着时 → `ERR_FLAG_IN_USE`（`details.by` 给出是谁）。

### 规则

每条规则 `{ id, match, conditions, serve }`：

- `id` 非空、同一个开关里不能重名；`serve` 必须是这个开关的 variation；
- `match` 只能是 `'all'`（默认）或 `'any'`；
- `conditions` 是数组，每项 `{ attribute, operator, values }`，`values` 必须是数组（`exists` 可以不写）；
- 支持的 `operator`：`eq`、`in`、`contains`、`startsWith`、`endsWith`、`gt`、`lt`、`exists`。

条件怎么算（**缺属性**和**值是 null** 是两回事）：

| operator | 成立条件 |
|---|---|
| `exists` | `attributes` 里有这个键（值是 `null` 也算有） |
| `eq` | 有这个键且 `值 === values[0]`（严格相等，`'1'` 不等于 `1`，`null` 只等于 `null`） |
| `in` | 有这个键且 `values` 里包含这个值（严格相等） |
| `contains` / `startsWith` / `endsWith` | 有键、值和 `values[0]` **都是字符串**，并且满足对应关系 |
| `gt` / `lt` | 有键、值和 `values[0]` **都是 number**，并且严格大于 / 小于 |

缺属性时除 `exists` 外一律不成立。`match: 'all'` 要所有条件成立（空数组恒真），
`match: 'any'` 只要一个成立（空数组恒假）。

### 灰度分桶

`rollout` 是 `[{ variation, weight }]`，`weight` 是 `0..bucketCount`（默认 1000）的整数，
**加起来必须正好等于 `bucketCount`**，`variation` 必须在 `variations` 里且不重复，
否则 `ERR_BAD_ROLLOUT`。

分桶哈希（要一字不差）：

```
bucket = fnv1a32(`${开关名}:${用户 userKey}`) % bucketCount
fnv1a32: h = 2166136261
         对 UTF-8 的每个字节 b： h = (h ^ b) >>> 0; h = Math.imul(h, 16777619) >>> 0
```

从 `rollout` 的第一项开始累加 `weight`，`bucket < 累计值` 就落在这个 variation。
**分桶只跟开关名和 userKey 有关**，所以改权重只是挪边界，已经在前面那档的人不会掉出去。

### 求值

`evaluate({ key, context })`，`context` 是 `{ userKey, attributes }`（`userKey` 必须是非空字符串，
`attributes` 不给就是 `{}`）。顺序是：

1. **依赖**：`requires: [{ flag, variation }]` 里每一项都拿**同一个 context** 去求值
   （递归），只要有一个不等于要求的 variation，就返回 `offVariation`、`reason: 'prerequisite'`；
2. **规则**：按声明顺序，第一条命中的用它的 `serve`，`reason: 'rule'`，`ruleId` 是那条规则的 id；
3. **灰度**：按上面的分桶落档，`reason: 'rollout'`；
4. 都没有就落到 `offVariation`，`reason: 'default'`。

返回 `{ key, variation, reason, ruleId, version }`，`ruleId` 只有规则命中时才有值。
`requires` 引用的开关必须**已经定义**（否则 `ERR_UNKNOWN_FLAG`），引用的 variation 也必须在
它的 `variations` 里（否则 `ERR_BAD_FLAG`）；`updateFlag` 要能查出依赖成环 → `ERR_FLAG_CYCLE`。

`evaluateAll({ context })` 按开关名升序把所有开关求一遍。
`list()` 按开关名升序返回 `{ key, version, variations }`。
`stats()` → `{ flags, evaluations, byReason: { prerequisite, rule, rollout, default } }`：
`evaluations` 只数顶层那次 `evaluate`，依赖递归出来的求值不单独计数。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_CONFIG` | `config` 不是对象、`bucketCount` 不是正整数 |
| `ERR_BAD_FLAG` | 开关定义本身有问题：`key` / `variations` / `offVariation` / `rules` / `requires` 不合法 |
| `ERR_BAD_ROLLOUT` | 灰度那部分不合法 |
| `ERR_DUPLICATE_FLAG` | 同一个 key 定义两次 |
| `ERR_UNKNOWN_FLAG` | 开关没见过，或者 `requires` 指了一个还没定义的开关 |
| `ERR_FLAG_IN_USE` | 还被别的开关依赖着就想删 |
| `ERR_FLAG_CYCLE` | 依赖成环（包括指向自己） |
| `ERR_BAD_CONTEXT` | `context` 不是对象、`userKey` 不是非空字符串、`attributes` 不是对象 |

## API

```js
import { createFlagEngine, DEFAULTS } from './lib/flagr.js';

const engine = createFlagEngine();
engine.defineFlag({
  key: 'checkout',
  variations: ['on', 'off'],
  offVariation: 'off',
  rollout: [{ variation: 'on', weight: 100 }, { variation: 'off', weight: 900 }],
});

engine.evaluate({ key: 'checkout', context: { userKey: 'u-1' } });
// -> { key, variation, reason: 'rollout' | 'rule' | 'prerequisite' | 'default', ruleId, version }

engine.updateFlag({ ... });
engine.evaluateAll({ context: { userKey: 'u-1' } });
engine.list();
engine.stats();
```

出错一律抛 `FlagError`（`lib/errors.js`），按 `code` 分流。

## demo 跑出来应该长这样

`npm run demo` 里用户和权重都是写死的，输出每一行都能对上：

```
flagr demo
[1] 定义一个 50/50 的灰度开关
    define {"key":"checkout","version":1}
[2] 同一个用户每次都落在同一档
    evaluate u-1 -> on (rollout) v1
    evaluate u-1 -> on (rollout) v1
[3] 权重从 50/50 改成 90/10，已经命中的人不会掉出去
    evaluate u-1 -> on (rollout) v2
[4] 规则优先于灰度
    evaluate staff -> beta (rule:staff) v3
    evaluate guest -> on (rollout) v3
[5] 依赖没满足，开关直接不生效
    evaluate billing -> off (rollout) v1
    evaluate billing-v2 -> off (prerequisite) v1
[6] 统计
    {"flags":3,"evaluations":8,"byReason":{"prerequisite":1,"rule":1,"rollout":6,"default":0}}
```
