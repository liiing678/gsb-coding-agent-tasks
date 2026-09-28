# calexpand

把重复日程（RRULE 的一个子集）展开成具体发生时间：本地日历上算，输出 UTC 时刻，
夏令时、改期、例外都得对。只用 Node 标准库，`node >= 20`。

```
calexpand/
├── lib/
│   ├── expand.js     expandSeries 本体                     ← 还没实现
│   ├── ics.js        RRULE 解析与校验、墙钟字符串解析
│   ├── tz.js         时区换算：墙钟 <-> UTC 时刻（Intl 的 tz 库）
│   └── errors.js     CalError 与全部错误码
├── test/             rules / dst / overrides 三组用例
├── scripts/demo.mjs  手工过一遍的演示脚本
└── package.json      npm test / npm run demo
```

```
npm test        # 23 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 系列长什么样

```js
{
  tz: 'America/New_York',
  start: '2026-03-01T09:00:00',   // 本地墙钟，没有偏移
  duration: 60,                   // 分钟，墙钟时长
  rule: 'FREQ=WEEKLY;BYDAY=SU;COUNT=3',
  exdates: ['2026-03-08T09:00:00'],
  rdates: ['2026-03-20T09:00:00'],
  overrides: [{ at: '2026-03-15T09:00:00', start: '2026-03-15T14:00:00', duration: 45 }],
}
```

- 所有时间字符串都是本地墙钟 `YYYY-MM-DDTHH:MM:SS`，不带偏移、不带 `Z`；
  输出才是 UTC 时刻（`...Z`）。`tz` 不传按 `UTC` 算，传了认不出来就报错。
- 一次发生 = 一个开始墙钟 + 时长。`end` 是「开始墙钟 + duration 分钟」再换算成时刻，
  所以跨夏令时的时候时长还是墙钟上的那点时间。

### 规则支持到哪

支持：`FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`、`INTERVAL`、`COUNT`、`UNTIL`、`BYDAY`
（含 `2TU` / `-1FR` 这种序数）、`BYMONTHDAY`（含负数，`-1` 是最后一天）、`BYMONTH`、
`BYSETPOS`、`WKST`。

不支持，遇到就报 `ERR_UNSUPPORTED_RULE`：`FREQ=SECONDLY|MINUTELY|HOURLY`、
`BYWEEKNO`、`BYYEARDAY`、`BYSETPOS` 用在 `MONTHLY|YEARLY` 以外的频率上、
`BYMONTHDAY` 和 `BYDAY` 同时给、`WEEKLY` 上加 `BYMONTH`。

语法不合规（没有 `FREQ`、`COUNT` 和 `UNTIL` 一起给、`INTERVAL=0`、`BYDAY=2MO`
用在非 `MONTHLY|YEARLY` 上、不认识的 key……）报 `ERR_BAD_RULE`。

### 展开语义

- 展开在**本地日历**上做：一天一天、一周一周、一月一月地推墙钟，推完再换算成时刻。
  所以跨夏令时之后本地钟点不变（还是 09:00），UTC 时刻会挪一小时。
- `WEEKLY` 的周按 `WKST` 切（默认 `MO`），`INTERVAL=2` 就是隔一个这样的周。
- `MONTHLY` / `YEARLY` 里带序数的 `BYDAY`（`2TU`、`-1FR`）按「这个月的第几个星期几」算；
  `BYSETPOS` 对每个周期（`MONTHLY` 是一个月、`YEARLY` 是一整年）排好序的候选列表取第 n 个，
  负数是倒数。
- 候选落在 `DTSTART` 之前的直接丢掉（第一次永远不早于 `start`）。
- `UNTIL` 是本地墙钟，含边界那一次；`COUNT` 数的是规则自己展开出来的次数。
  `EXDATE` 只是让某一次不产出，**不把 COUNT 的名额吐回来**，后面的序号也不变。
- `RDATE` 是额外加的发生，展开完一起排序；`override` 按 `at`（原始那次的墙钟）匹配，
  可以改时间、改时长，也可以 `cancelled: true` 取消。匹配不上任何一次就报 `ERR_BAD_OVERRIDE`。
- 同一次同时被 `EXDATE` 和 `override` 命中时，先看 override（取消就不产出，改期就按新的来）。

### 夏令时三档

墙钟换算成时刻时有三种情况，写进结果的 `kind`：

| kind | 什么时候 | 怎么算 |
|---|---|---|
| `exact` | 正常情况 | 直接用当时的偏移 |
| `gap` | 春季跳表，这个墙钟压根不存在（比如纽约 2026-03-08 02:30） | 按跳表**之后**的偏移算，时间往后挪 |
| `ambiguous` | 秋季回拨，这个墙钟出现两次（比如纽约 2026-11-01 01:30） | 取**先发生**的那一次，偏移用回拨前的 |

### 窗口、序号和上限

- `options.from` / `options.to` 是 UTC 时刻（`...Z` 字符串或毫秒数），按**开始时刻**筛，
  两端都算在内；不传就是不限。
- `sequence` 是**这次返回的结果里**的序号：筛完窗口、排完序之后从 1 开始连续编号。
- 结果按 `start` 升序，同一时刻按 `recurrenceId` 升序。
- `options.limit`（默认 1000）是结果条数上限，超了报 `ERR_LIMIT_EXCEEDED`；
  `options.maxIterations`（默认 100000）是内部周期数上限，展开停不下来也报这个错。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_SERIES` | `start` / `duration` / `from` / `to` 这些字段本身不对 |
| `ERR_BAD_TIME` | 时间字符串不是 `YYYY-MM-DDTHH:MM:SS`，或者根本不是合法日期 |
| `ERR_BAD_TZ` | 时区名不认识 |
| `ERR_BAD_RULE` | RRULE 语法不合规 |
| `ERR_UNSUPPORTED_RULE` | 语法对，但这一版不支持的写法 |
| `ERR_BAD_OVERRIDE` | override 的 `at` 对不上任何一次发生 |
| `ERR_LIMIT_EXCEEDED` | 结果超过 `limit`，或者展开超过 `maxIterations` |

## API

```js
import { expandSeries, DEFAULTS } from './lib/expand.js';
```

### `expandSeries(series, options = {})`

返回数组，每项：

```js
{
  recurrenceId: '2026-03-08T09:00:00', // 原始那次的墙钟，改期之后也不变
  sequence: 2,                          // 结果里的序号，从 1 开始
  start: '2026-03-08T13:00:00Z',        // UTC 时刻
  end: '2026-03-08T14:00:00Z',
  localDate: '2026-03-08',
  localTime: '09:00:00',
  offsetMinutes: -240,                  // 开始时刻的偏移
  kind: 'exact',
  modified: false,                      // 被 override 改过就是 true
}
```

`lib/ics.js` 和 `lib/tz.js` 已经是成品，不要再改：`parseWall(text)` 校验墙钟字符串、
`parseRule(text)` 解析并校验 RRULE、`localToUtc(tz, wall)` 做墙钟到时刻的换算（返回
`{ instant, offsetMinutes, kind }`）、`utcToLocal(tz, ms)` 反过来算、`isoZ(ms)` 出 `...Z`。

## demo 跑出来应该长这样

`npm run demo` 里的时刻和时区都是写死的，输出每一行都能对上：

```
calexpand demo
[1] 上海，每周一三五 09:00，取四次
    2026-01-05 09:00:00 -> 2026-01-05T01:00:00Z (exact, +8h)
    2026-01-07 09:00:00 -> 2026-01-07T01:00:00Z (exact, +8h)
    2026-01-09 09:00:00 -> 2026-01-09T01:00:00Z (exact, +8h)
    2026-01-12 09:00:00 -> 2026-01-12T01:00:00Z (exact, +8h)
[2] 纽约，每周日 09:00，正好跨过春季跳表
    2026-03-01 09:00:00 -> 2026-03-01T14:00:00Z (exact, -5h)
    2026-03-08 09:00:00 -> 2026-03-08T13:00:00Z (exact, -4h)
    2026-03-15 09:00:00 -> 2026-03-15T13:00:00Z (exact, -4h)
[3] 纽约，凌晨 01:30 每天一次，撞上秋季回拨
    2026-10-31 01:30:00 -> 2026-10-31T05:30:00Z (exact, -4h)
    2026-11-01 01:30:00 -> 2026-11-01T05:30:00Z (ambiguous, -4h)
    2026-11-02 01:30:00 -> 2026-11-02T06:30:00Z (exact, -5h)
[4] 每月最后一个工作日，中间那次挪到下午
    2026-01-30 18:00:00 -> 2026-01-30T10:00:00Z (exact, +8h)
    2026-02-28 10:00:00 -> 2026-02-28T02:00:00Z (exact, +8h, 改过)
    2026-03-31 18:00:00 -> 2026-03-31T10:00:00Z (exact, +8h)
```
