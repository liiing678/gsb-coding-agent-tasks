# policygate

属性化访问决策：策略按主体 / 动作 / 资源匹配，再过一遍条件，按优先级和"同档拒绝优先"
定下结果，顺带把结论缓起来。只用 Node 标准库，没有第三方包，`node >= 20`。

```
policygate/
├── lib/
│   ├── engine.js      createEngine 本体                      ← 还没实现
│   ├── conditions.js  条件求值（路径、比较器、缺失属性）
│   └── errors.js      PolicyError 与全部错误码
├── test/              match / decide / cache 三组用例
├── scripts/demo.mjs   手工过一遍的演示脚本
└── package.json       npm test / npm run demo
```

```
npm test        # 21 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 属性表

```js
const attributes = {
  subjects: {
    alice: { roles: ['editor'], groups: ['staff'], attrs: { dept: 'eng', level: 4 } },
  },
  resources: {
    'doc:1': { type: 'doc', tags: ['public'], attrs: { owner: 'alice', year: 2024 } },
  },
  roles: { editor: { attrs: { canEdit: true, level: 2 } } },
  types: { doc: { attrs: { kind: 'content' } } },
};
```

判定时把请求里的主体 / 资源拼成一个作用域（条件里的 `subject.*` / `resource.*` 就是查它）：

- 主体作用域：先铺它所有角色的属性（`roles` 里靠后的角色盖前面的），再用 subject 自己的
  `attrs` 盖一遍，最后放 `id` / `roles` / `groups`。
- 资源作用域：先铺它类型的属性，再用资源自己的 `attrs` 盖一遍，最后放 `id` / `type` / `tags`。
- 上下文作用域：`request.context` 原样（不给就是空对象）。
- 请求里的主体或资源在属性表里查不到，直接抛 `ERR_BAD_REQUEST`。

### 策略

```js
{
  id: 'editors-recent',        // 非空、全表唯一
  effect: 'allow',             // allow | deny
  priority: 5,                 // 整数，默认 0
  subjects: ['role:editor'],   // '*' | 具体 id | 'role:x' | 'group:x'
  actions: ['read'],           // '*' | 具体动作 | 'write*'（结尾通配）
  resources: ['doc:*'],        // '*' | 具体 id | 前缀通配
  when: { 'resource.year': { gte: 2020 } },   // 可选
  obligations: { mask: ['ssn'] },             // 可选，跟着结论带出来
}
```

一条策略"命中" = 主体、动作、资源三步都匹配上，`when` 里的条件全部成立。三个列表都是
"命中任意一项即可"。

### 条件

- 路径写成 `subject.x` / `resource.x` / `context.x`，一级属性，别写点里套点。
- 比较器：`eq` `ne` `in` `gt` `gte` `lt` `lte` `has` `notHas` `exists`，语义在
  `lib/conditions.js` 里写死了，直接用它的 `evaluateConditions`。
- 同一个路径下写多个比较器是"且"，`when` 里多个路径之间也是"且"。
- **属性缺失时，除了 `exists`，其它比较器一律算不成立**，并且这次判定会被记成
  "缺属性"（`explain` 里能看到 `:missing`）。

### 怎么定结论

1. 命中的策略按 `priority` 从大到小排；同一个优先级按 `id` 升序（排出来的就是结果里的
   `matchers`，`id` 列表）。
2. 取 `priority` 最大的那一档；**这一档里只要有 `deny`，结论就是拒绝**，否则是放行。
3. 一条都没命中 → 默认拒绝，`reason` 是 `no-match`、`policy` 是 `null`。

结论长这样：

```js
{
  effect: 'allow',            // allow | deny
  policy: 'editors-recent',   // 定下来的那条策略；默认拒绝时是 null
  priority: 5,                // 上面那条的优先级；默认拒绝时是 null
  reason: 'allow-by-policy',  // allow-by-policy | deny-by-policy | no-match
  matchers: ['editors-recent', ...],  // 命中的策略 id，按上面排好的顺序
  obligations: { mask: ['ssn'] },     // 定下来的那条的 obligations，没有就是 {}
}
```

`enforce()` 在结论是拒绝时抛 `ERR_ACCESS_DENIED`，`details` 带 `policy` / `reason` /
`matchers`；放行时返回上面那个对象。

### 缓存

- `evaluate()` 的结果按请求（subject / action / resource / context，context 按键排序后的
  内容比）缓存起来，同样的请求第二次直接给同一份结论。
- `setPolicies()` / `setAttributes()` 会把缓存清空；`invalidate()` 手动清，返回清掉几条。
- `cacheStats()` 给 `{ hits, misses, size }`。
- `explain()` 每次现算，**不走缓存**。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_POLICY` | `id` 空或重复、`effect` 不是 allow/deny、`priority` 不是整数、三个列表不是非空字符串数组、`when` 路径或比较器不合法、`obligations` 不是对象 |
| `ERR_BAD_REQUEST` | `subject` / `action` / `resource` 空、`context` 不是对象、主体或资源在属性表里没有 |
| `ERR_ACCESS_DENIED` | `enforce()` 碰到拒绝结论 |

## API

```js
import { createEngine, DEFAULTS } from './lib/engine.js';

const engine = createEngine({ policies, attributes });

engine.evaluate({ subject: 'alice', action: 'read', resource: 'doc:1' });
// -> { effect, policy, priority, reason, matchers, obligations }

engine.enforce({ subject: 'alice', action: 'read', resource: 'doc:9' });
// -> 放行时同上；拒绝时抛 ERR_ACCESS_DENIED

engine.explain({ subject: 'bob', action: 'read', resource: 'doc:1' });
// -> [
//      'request bob read doc:1',
//      'policy auditor-old allow priority 9: no-match (subjects)',
//      'policy deny-secret deny priority 5: no-match (when:resource.tags)',
//      'policy editors-recent allow priority 5: no-match (subjects)',
//      'decision: deny by none',
//    ]

engine.setPolicies(nextPolicies); // 换策略，缓存清掉
engine.setAttributes(nextAttributes); // 换属性表，缓存清掉
engine.invalidate(); // 手动清缓存，返回清掉几条
engine.cacheStats(); // -> { hits, misses, size }
engine.policies(); // -> 策略 id 列表
```

`explain()` 的行只有这几种形状：`request <主体> <动作> <资源>`、
`policy <id> <effect> priority <n>: matched`、
`policy <id> <effect> priority <n>: no-match (<subjects|actions|resources>)`、
`policy <id> <effect> priority <n>: no-match (when:<路径>)`（属性缺失时是
`when:<路径>:missing`）、最后一行 `decision: <effect> by <策略 id 或 none>`。

出错一律抛 `PolicyError`（`lib/errors.js`），按 `code` 分流；条件求值用
`lib/conditions.js`，别改也别绕开。

## demo 跑出来应该长这样

`npm run demo` 里的策略和属性都是写死的，输出每一行都能对上：

```
policygate demo
[1] 编辑看自己部门近两年的公开文档
    read doc:1: allow by editors-recent (allow-by-policy)
      matchers editors-recent
      obligations {"mask":["ssn"]}
[2] 同一个人去碰标着 secret 的文档，被那条 deny 拦住
    read doc:9: deny by deny-secret (deny-by-policy)
      matchers deny-secret
[3] 带上 gold，优先级更高的那条 allow 压过同档的 deny
    read doc:9: allow by auditor-old (allow-by-policy)
      matchers auditor-old,deny-secret
[4] 换成 bob：staff 那条轮不到他，同一档里 deny 赢
    read doc:9: deny by deny-secret (deny-by-policy)
      matchers deny-secret
[5] 谁也没命中就是默认拒绝，explain 一行行摊开
    request bob read doc:1
    policy auditor-old allow priority 9: no-match (subjects)
    policy deny-secret deny priority 5: no-match (when:resource.tags)
    policy editors-recent allow priority 5: no-match (subjects)
    decision: deny by none
[6] 同一个请求第二次走缓存
    hits=1 misses=4 size=4
```
