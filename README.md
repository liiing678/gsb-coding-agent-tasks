# stateflow

层级状态机（SCXML 那一套的简化子集）：状态树、初始链、历史状态、事件队列，
退和进按什么顺序发生，全都要一模一样地复现出来。只用 Node 标准库，没有第三方包，`node >= 20`。

```
stateflow/
├── lib/
│   ├── stateflow.js   createMachine / run   ← 还没实现
│   └── errors.js      StateflowError 与全部错误码
├── test/              machine / history 两组用例
├── scripts/demo.mjs   手工过一遍的演示脚本
└── package.json       npm test / npm run demo
```

```
npm test        # 11 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 机器定义

```js
{
  id: 'job',
  initial: 'idle',
  states: [
    { id: 'idle', on: { START: 'running' } },
    {
      id: 'running',
      initial: 'fast',
      history: true,
      states: [
        { id: 'fast', on: { SLOW: 'slow' } },
        { id: 'slow', on: { FAST: 'fast' } },
      ],
      on: { DONE: 'done', PAUSE: 'paused', RESTART: 'running' },
    },
    { id: 'paused', on: { RESUME: { target: 'running', viaHistory: true } } },
    { id: 'done', final: true },
  ],
}
```

- 状态的字段是 `{ id, initial?, states?, history?, final?, on? }`：
  - `id` 非空字符串，**整棵树的 id 不能重样**；转换的目标就直接按 id 在全树里找；
  - 给了 `states` 就是复合状态，这时**必须**同时给 `initial`，而且它得是某个直接子状态的 id；
    没给 `states` 就是叶子；
  - `states: []`、只有 `initial` 没有 `states`、`initial` 指不到直接子状态，都算定义有问题；
  - `final: true` 只能给叶子，`history: true` 只能给复合状态；
  - `on` 是 `{ 事件名: 转换 | [转换, ...] }`，转换写成目标 id，或者
    `{ target, when?, assign?, viaHistory? }`，四个字段以外的不认。
- 初始活跃集合 = 根，外加从根顺着 `initial` 一路走到底的那条链。

### createMachine / state / reset

`createMachine(definition, { context } = {})` 建一台机器（`context` 不给就是空对象）：

- 建的时候就把初始链算好。`state()` 返回 `{ active, context, done, queued }`：
  - `active` 是**根到叶**的状态 id 数组（含根）；
  - `context` 是机器数据的拷贝，外面改不动里面那份；
  - `done` 看当前活跃集合里有没有 `final` 状态；
  - `queued` 是排着队还没处理的内部事件名。
- `reset()` 回到初始链、清空队列和历史、`context` 回到建机器时那份，返回值跟 `state()` 一样。

### send：外部事件

`send(event)` 处理一个外部事件，返回 `{ matched, handled, trace, active, context, done, queued }`：

- `event` 必须是非空字符串。
- 处理顺序：**先把队列里的内部事件按 FIFO 清完**，再处理这次传进来的外部事件；
  处理过程中新排进来的继续接在后面清。一轮里处理的事件（含外部那个）超过
  `DEFAULTS.maxSteps`（100）就报 `ERR_TOO_MANY_EVENTS`。
- `handled` 是这一轮真正处理过的事件名，按处理顺序（没命中的也在里面）。
- `trace` 是这一轮所有的退/进记录，每条 `{ type: 'exit' | 'enter', state }`，`state` 是状态 id。
- 一条转换都没匹配上时 `matched: false`，机器一动不动，`trace: []`。

### 挑哪条转换

- 从当前**最深的活跃叶子往上**找：先看叶子自己的 `on[event]`，再父状态，一路到根；**先命中的状态先算**。
- 同一个状态里同一个事件写了多个转换就按数组顺序试，**第一个 `when` 满足的才算**：
  - `when` 是 `{ 键: 值 }`，每个键都要跟 `context` 里的值 `Object.is` 相等；不写 `when` 就是无条件。
- `viaHistory: true` 是「进这个复合状态时用它的历史」，不写就走 `initial`。

### 退和进

- 记 `source` 是命中那条转换的状态，`target` 是目标状态；`keep` 是两者**最近公共祖先的父状态**，
  最近公共祖先就是根的时候 `keep` 就是根（根不会被退掉）。
- 退出：当前活跃集合里凡是不等于 `keep` 的那些状态，**从内到外**依次退出；`keep` 留在原地。
- `assign` 在**退出做完之后、进入之前**浅合并进 `context`。
- 进入：`target` 往上到 `keep` 的路径（不含 `keep`）**从外到内**依次进入；每进一个复合状态，
  就顺着它的 `initial` 一路进到叶子。
- **历史**：带 `history: true` 的复合状态，在**退出它的时候**记下当时的那片叶子；
  下次有 `viaHistory: true` 的转换进到它，就照着记下的叶子一路进（沿途祖先按外到内进），
  不走 `initial`。没记过就还是走 `initial`。
- 目标就是 `source` 自己（比如 `running` 上的 `RESTART: 'running'`）：`keep` 是 `source` 的父状态，
  所以它自己也要退出去再重新进来，等于把初始链重走一遍 —— 除非那条转换写了 `viaHistory`。
- 进了 `final` 状态 `done` 就变 true；final 自己不会匹配事件，它的祖先照常能。

## API

```js
import { createMachine, run, DEFAULTS } from './lib/stateflow.js';

const machine = createMachine(definition, { context: { retry: 0 } });

machine.state();          // -> { active, context, done, queued }
machine.send('START');    // -> { matched, handled, trace, active, context, done, queued }
machine.raise('TICK');    // 排一个内部事件，下一次 send 先处理它
machine.reset();

run(definition, ['START', 'SLOW'], { context });
// -> { results, handled, active, context, done, queued }
DEFAULTS;                 // -> { maxSteps: 100 }
```

`run` 就是按顺序 `send` 一串事件：`results` 是每次 `send` 的返回值，`handled` 把它们合起来。

出错一律抛 `StateflowError`（`lib/errors.js`），按 `code` 分流：

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_MACHINE` | 定义的形状不对：不是对象、`id` 不是非空字符串、id 重样、复合状态的 `states` 不是非空数组、复合状态没 `initial` 或 `initial` 指不到直接子状态、叶子给了 `initial`、`final` 带了子状态、`history` 给了叶子、`on` 不是对象、事件名是空串、转换既不是字符串也不是对象、转换对象里有不认识的字段、`target` 不是非空字符串或树里找不到、`when` / `assign` 不是对象；`options` / `context` 不是对象 |
| `ERR_BAD_EVENT` | `send` / `raise` 收到的事件名不是非空字符串；`run` 的 `events` 不是数组 |
| `ERR_TOO_MANY_EVENTS` | 一轮里处理的事件数超过 `DEFAULTS.maxSteps` |

## demo 跑出来应该长这样

```
stateflow demo
  initial ["job","idle"]
  START active=["job","running","fast"] trace=exit:idle enter:running enter:fast
  SLOW active=["job","running","slow"] trace=exit:fast exit:running enter:running enter:slow
  PAUSE active=["job","paused"] trace=exit:slow exit:running enter:paused
  RESUME active=["job","running","slow"] trace=exit:paused enter:running enter:slow
  RESTART active=["job","running","fast"] trace=exit:slow exit:running enter:running enter:fast
  DONE active=["job","done"] trace=exit:fast exit:running enter:done
  run active=["job","done"] handled=["START","SLOW","DONE"]
  guard fast job/quick
  guard retry job/slow
  guard fallback job/done
  queued ["TICK","TOCK"]
  maxSteps 100
```
