# tickwheel 起始环境

服务里的定时调度器：按 cron 表达式算下一次该在什么时候跑，到点把 job 交出去，管住不重叠和收尾。
**要写的那块是空的**：`lib/scheduler.js` 里的 `parseCron` 和 `createScheduler` 现在只会抛
`NotImplementedError`，其余是骨架、口径和用例。

## 怎么跑

不用 `npm install`，这个仓库没有任何第三方依赖，`package.json` 里也不要加 `dependencies`。

```
npm test                                 # node --test test/tickwheel.test.js
npm run demo                             # node scripts/demo.js --config configs/dev.json
```

演示不需要外部服务：`scripts/demo.js` 用 `lib/manual-clock.js` 把时间快进过去，
看看夏令时那两个晚上和"上一次还没跑完"的时候调度器怎么走。

## 目录

| 路径 | 说明 |
|---|---|
| `lib/scheduler.js` | **要你写的部分**：`parseCron(expression, timeZone)` 和 `createScheduler({...})` |
| `lib/manual-clock.js` | 手动时钟（已实现，别改）：演示和用例靠它推时间 |
| `lib/config.js` | 读配置、校验（已实现，别改） |
| `lib/counters.js` | 计数器（已实现，别改） |
| `lib/errors.js` | `CronParseError` / `SchedulerStateError`（已实现，别改） |
| `scripts/demo.js` | 演示入口 |
| `test/tickwheel.test.js` | 用例，现在跑是红的 |
| `configs/dev.json` | 演示和默认配置 |

## 接口

```js
parseCron(expression, timeZone) -> { expression, timeZone, next(afterMs) }

createScheduler({
  config,    // configs/dev.json 里 tickwheel 那一段（config.js 已经校验过）
  counters,  // lib/counters.js
  now,       // 取当前时间，默认 () => Date.now()
  sleep,     // 等 ms 毫秒，默认 setTimeout；演示和用例会换成手动时钟
}) -> { add(job), start(), stop(), stats() }
```

- `parseCron(expression, timeZone)`：解析五段的 cron 表达式；看不懂的表达式、不认识时区，
  都抛 `CronParseError`。
  - `next(afterMs)` 返回严格大于 `afterMs` 的下一个触发时刻（epoch 毫秒，对齐到整分钟）；
    往后五年都算不出来（比如 `0 0 30 2 *`）就返回 `null`。
- `createScheduler(...)`：
  - `add({ name, cron, run, timeZone })`：注册一个 job。`name` 不能是空串、不能重名，
    `run` 是个函数，被调用时会拿到这次该触发的时间点（epoch 毫秒）；`run` 可以是同步的，
    也可以返回 promise。`timeZone` 不写就用 `config.timeZone`。
  - `start()`：开始调度。重复调用没反应。
  - `stop()`：返回 promise，语义见下。
  - `stats()`：同步返回 `{ timeZone, jobs, running, counters }`：
    `jobs` 是注册的 job 名字，`running` 是这会儿还在跑的 job 名字，`counters` 是
    `counters.snapshot()`。

## 口径

### cron 表达式

五段：`分 时 日 月 周`，空白分隔。每段支持 `*`、`a`、`a-b`、`*/n`、`a-b/n`、`a,b,c`
（逗号里也可以套范围和步长）。取值范围：分 `0-59`，时 `0-23`，日 `1-31`，月 `1-12`，
周 `0-7`（`0` 和 `7` 都是周日）。

- **日和周都不是 `*` 的时候按"或"算**：`0 0 1 * 1` 是"每月 1 号 或 每周一"。
- 日和周里只要有一个是 `*`，另一个就按"与"的顺序照常卡。
- 步长必须 ≥ 1，`*/0` 这种直接算表达式错。

### 时区与夏令时

- 表达式里的时间都是 `timeZone` 的本地时间，用 IANA 名字（`Asia/Shanghai`、
  `America/New_York` 这种）。`config.timeZone` 是默认值，job 上可以单独写。
- 本地时间**不存在**的那些分钟（春季跳表）：顺延到跳表之后的第一个整分钟触发一次。
  比如 `America/New_York` 2026-03-08 的本地 `02:30` 不存在，这一天就该在本地 `03:00` 跑。
- 本地时间**出现两次**的那些分钟（秋季回拨）：只在第一次触发。
  比如 `America/New_York` 2026-11-01 的本地 `01:30` 会出现两次，这一天只跑一次。

### 调度

- 每个 job 各自算自己的下一个触发点；到点了就把 `run` 交出去。
- **同一条 job 不重叠**：上一次的 `run` 还没结束就又到点了，这一次跳过，记一笔
  `tickwheel_overlap_skipped_total`，不排队、不并发跑同一条 job。不同 job 之间互不影响。
- `run` 抛错或者 reject：记一笔 `tickwheel_failed_total`，这条 job 后面的触发照常，别人也不受影响。
- 同一个触发时刻只触发一次。时钟被往回拨之后，已经触发过的那个时间点不会再触发一遍。
- 实现里不要直接写 `Date.now` / `setTimeout` / `new Date()` 拿当前时间，`now` 和 `sleep` 都从参数里拿。

### stop

- `stop()` 之后不再触发新的时间点；正在跑的 `run` 不打断，等它们跑完 `stop()` 才 resolve。
- 重复 `stop()` 返回同一个 promise。
- `stop()` 之后再 `start()`、`start()` 之后再 `add()`、同名 job 注册两次、`name` 是空串、
  `run` 不是函数：都抛 `SchedulerStateError`。

### 计数器

名字固定，别改名、也别加新的：

| 名字 | 什么时候加 |
|---|---|
| `tickwheel_jobs_total` | `add()` 成功注册一个 job 加一 |
| `tickwheel_fired_total` | 真正调了一次 `run` 加一 |
| `tickwheel_overlap_skipped_total` | 到点了但上一次还在跑，跳过加一 |
| `tickwheel_failed_total` | `run` 抛错或者 reject 加一 |

## 演示输出

`npm run demo` 现在跑不起来（调度器还没写）。写完之后的输出是这样：

```
[1] 每天 09:00，跨一次夏令时
    2026-03-06 09:00  (2026-03-06 14:00Z)
    2026-03-07 09:00  (2026-03-07 14:00Z)
    2026-03-08 09:00  (2026-03-08 13:00Z)
    2026-03-09 09:00  (2026-03-09 13:00Z)
    一共跑了 4 次
[2] 每天 02:30，3 月 8 日这天本地没有 02:30
    2026-03-08 03:00  (2026-03-08 07:00Z)
    2026-03-09 02:30  (2026-03-09 06:30Z)
    一共跑了 2 次
[3] 每天 01:30，11 月 1 日这天 01:30 会出现两次
    2026-11-01 01:30  (2026-11-01 05:30Z)
    2026-11-02 01:30  (2026-11-02 06:30Z)
    一共跑了 2 次
[4] 每 10 分钟一次，但这一次跑不完
    真开了 1 次，跳过了 2 次
    stop() 的时候那次还没跑完 -> true
    stop() 回来了
    再推进 30 分钟，一共还是开了 1 次
```

## 自检

`npm test` 全绿就算过关，`test/tickwheel.test.js` 里每条用例的注释写了它在验什么。

`configs/dev.json`、`test/` 下的用例是评测用的，不要改、不要补、不要删。
