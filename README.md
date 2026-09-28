# cronplan

一批定时任务要按 cron 跑，任务之间还有依赖（上游没跑完下游不能跑），而且上游失败/跳过的下游也得跟着跳过，
重试要按退避排。这个模块负责把"某段时间里到底要跑哪些次、谁先谁后、跑挂了会牵连谁"算清楚。
只用 Node 标准库，没有第三方包，`node >= 20`。

```
cronplan/
├── lib/
│   ├── scheduler.js createScheduler 本体                  ← 还没实现
│   └── errors.js    SchedulerError 与全部错误码
├── test/            cron / schedule 两组用例
├── scripts/demo.mjs 手工过一遍的演示脚本
└── package.json     npm test / npm run demo
```

```
npm test        # 13 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 配置

`createScheduler({ clock })`：`clock` 不给就用系统时间，**只用来给不带 `to` 的窗口兜底**；
不是函数就 `ERR_BAD_CONFIG`，配置不是对象也一样。

### cron 表达式

5 段：`分 时 日 月 周`，段之间一个空格。**一律按 UTC 展开**。

| 段 | 取值范围 |
|---|---|
| 分 | 0 ~ 59 |
| 时 | 0 ~ 23 |
| 日 | 1 ~ 31 |
| 月 | 1 ~ 12 |
| 周 | 0 ~ 7（**0 和 7 都是周日**） |

每一段可以写：

- `*` 全部；
- `n` 单个值；
- `a-b` 闭区间；
- `*/n` 从该段最小值开始按步长取；
- `a-b/n` 从 `a` 开始按步长取；
- `a,b,c` 列表，上面几种可以混着拼。

**日和周都被限定时取并集**（标准的 cron 语义）：`0 0 1 * 0` 是"每月 1 号**或**每周日"，
不是"既是 1 号又是周日"。只有一边被限定就按那一边，两边都是 `*` 就只看月。

### 任务定义

`defineJob({ id, cron, dependsOn, retries, backoffMs })`：

- `id` 是非空字符串，只能有字母数字和 `_ . : -`，不能重名。
- `cron` 按上面的语法校验，不合法 `ERR_BAD_CRON`。
- `dependsOn` 是任务 id 数组，**依赖的任务必须先定义过**，否则 `ERR_UNKNOWN_DEP`；
  数组里不能有重复；依赖自己 `ERR_CYCLE`。
- `retries` 默认 0，`backoffMs` 默认 1000，都必须是不小于 0 / 大于 0 的整数。
- `level` 由依赖算出来：没有依赖是 0，否则是 `1 + 上游里最大的 level`。

### 展开（plan）

`plan({ from, to })`：展开 `[from, to)` 这个窗口里的所有触发，`from` 必填，
`to` 不给就用 `clock()`；两者都是有限毫秒数，`from > to` 报 `ERR_BAD_PERIOD`。

**只看整分钟的触发点**：第一个可能命中的时刻是"不小于 `from` 的最小整分钟"，
一直到小于 `to`。所以 `from` 落在 `00:00:30` 时，这一分钟不算，从 `00:01:00` 开始。

每次触发产出：

```js
{ id, jobId, at, level, dependsOn, skipped }
```

- `id` 是 `` `${jobId}@${那一分钟的 UTC ISO}` ``，例如 `tick@2026-03-01T00:05Z`；
- `dependsOn` 是上游**这一次**触发的 id 列表：取每个上游任务在这个窗口里 `at <= 本次 at`
  的**最近一次**触发（同一条分钟上也算）；
- 窗口里根本找不到这样的上游触发时，`dependsOn` 里没有它，`skipped` 记 `'NO_UPSTREAM'`；
  找得到就是 `null`。

**排序**：先按 `at` 升序，同一时刻按 `level` 升序（上游先），同层再按 `jobId` 的码元序。
`execute` 也按这个顺序跑。

### 跑一轮（execute）

`execute({ from, to, perform })`：先按 plan 的规则展开，再依次处理每一次触发，
`perform` 不是函数报 `ERR_BAD_PERFORM`。`perform(run)` 收到
`{ id, jobId, at, level, attempt }`，必须返回：

- `'ok'`：这次算成功；
- `'fail'`：明确失败，**不再重试**；
- `'retry'`：这次没成，按退避重排一次。已经用掉的尝试次数达到 `retries + 1` 次还是没成，
  就判成失败；返回别的一律 `ERR_BAD_PERFORM`。

每个任务自己的 `retries` 是重试额度，第 k 次重试的计划时刻是
`at + backoffMs * 2 ** (k - 1)`（第一次重试就是 `at + backoffMs`）。

级联：`skipped` 是 `'NO_UPSTREAM'` 的那次**不调 perform**；
只要有一个上游这次是 `failed`，本次记 `skipped` / `'UPSTREAM_FAILED'`；
上游是 `skipped` 就记 `'UPSTREAM_SKIPPED'`（上游里又有失败又有跳过时，`UPSTREAM_FAILED` 优先）。

返回 `{ runs, stats }`，每条 run 是：

```js
{ id, jobId, at, level, dependsOn, status, reason, attempts, retryAts }
```

`status` 是 `'ok'` / `'failed'` / `'skipped'`；`reason` 只在失败/跳过时有值
（`'FAILED'` / `'RETRIES_EXHAUSTED'` / `'NO_UPSTREAM'` / `'UPSTREAM_FAILED'` / `'UPSTREAM_SKIPPED'`）；
`attempts` 是 perform 真正被调用的次数（跳过的是 0）；`retryAts` 是计划好的重试时刻。

### 统计

`stats()` → `{ jobs, longestChain, planned, ok, failed, skipped, retries }`：
`longestChain` 是最长依赖链上的任务个数（没有任务时是 0），`planned` 是 `plan()` 累计吐出的条数
（`execute` 自己展开的那一轮不算），其余是累计计数，`retries` 数的是**成功排上队的重试次数**。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_CONFIG` | 配置不是对象、`clock` 不是函数 |
| `ERR_BAD_JOB` | `id` / `dependsOn` / `retries` / `backoffMs` 不合法，任务重名 |
| `ERR_BAD_CRON` | cron 段数不对、越界、区间反了、步长为 0、有空项或非数字 |
| `ERR_UNKNOWN_DEP` | `dependsOn` 里的任务还没定义过 |
| `ERR_CYCLE` | 依赖自己 |
| `ERR_BAD_PERIOD` | `from` / `to` 不是有限毫秒数、`from > to` |
| `ERR_BAD_PERFORM` | 没给 `perform`，或者它返回了不认识的东西 |

## API

```js
import { createScheduler, parseCron, slot, FIELDS, MINUTE } from './lib/scheduler.js';

const scheduler = createScheduler({ clock: () => Date.now() });
scheduler.defineJob({ id: 'tick', cron: '* * * * *' });
scheduler.defineJob({ id: 'rollup', cron: '*/5 * * * *', dependsOn: ['tick'], retries: 2, backoffMs: 10000 });

scheduler.plan({ from: Date.parse('2026-03-01T00:00:00Z'), to: Date.parse('2026-03-01T00:10:00Z') });
// -> [{ id: 'tick@2026-03-01T00:00Z', jobId: 'tick', at, level: 0, dependsOn: [], skipped: null }, ...]

scheduler.execute({
  from, to,
  perform: (run) => (run.jobId === 'rollup' ? 'retry' : 'ok'),
});
// -> { runs: [...], stats: { jobs, longestChain, planned, ok, failed, skipped, retries } }

scheduler.stats();
```

出错一律抛 `SchedulerError`（`lib/errors.js`），按 `code` 分流。

## demo 跑出来应该长这样

`npm run demo` 里时间是写死的，输出每一行都能对上：

```
cronplan demo
[1] 窗口里每个任务各自触发几次
    tick=6 rollup=2 digest=6
[2] 依赖指到窗口里最近的那次上游
    digest@00:05 <- rollup@00:05
[3] 跑一轮：最后一次 rollup 一直 retry，重试额度用完就算失败
    rollup@00:05 attempts=2 status=failed reason=RETRIES_EXHAUSTED retryAt=00:05:30
[4] 挂在失败上游下面的那次跟着跳过
    digest@00:05 status=skipped reason=UPSTREAM_FAILED
[5] 统计
    {"jobs":3,"longestChain":3,"planned":14,"ok":12,"failed":1,"skipped":1,"retries":1}
```
