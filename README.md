# tideflow

事件时间窗口聚合：事件乱序进来，按事件时间切窗口，水位到了就发结果，迟到但还在宽限期里的
还能补进去。只用 Node 标准库，没有第三方包，`node >= 20`。

```
tideflow/
├── lib/
│   ├── stream.js     createAggregator 本体                   ← 还没实现
│   ├── agg.js        聚合算法（count / sum / min / max / avg）
│   └── errors.js     AggError 与全部错误码
├── test/             emit / late / state 三组用例
├── scripts/demo.mjs  手工过一遍的演示脚本
└── package.json      npm test / npm run demo
```

```
npm test        # 20 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 窗口怎么切

- 窗口按事件时间对齐：`windowStart = floor(eventTime / windowMs) * windowMs`，
  `windowEnd = windowStart + windowMs`，左闭右开。
- 窗口按 `key` 分开：同一个 key 才有同一个窗口，不同 key 各算各的。
- 每个窗口有一个聚合状态（`aggregations` 里每一项一份），窗口里的每个事件合进去一次。

### 水位

- `watermark = 见过的最大的 eventTime - watermarkDelayMs`。
- 水位只增不减：后面来了个时间更小的事件，水位不动。
- `advanceTo(t)` 直接把水位抬到 `t`（比当前小就当没给，返回空输出）。
- 关窗点是 `closeAt = windowEnd + allowedLatenessMs`。**水位 >= closeAt 的窗口就关掉**，
  关掉时发一条 `state: 'final'` 的记录，之后这个窗口的事件一概不受理。

### push 的顺序

一次 `push(event)` 按这个顺序走：

1. 校验事件（不合法直接抛，见下面的错误码）；
2. 先看水位：用这次事件的时间把水位往前推，**把到期的窗口关掉**——这些 `final` 记录按
   `(windowEnd, key)` 排序，排在这次输出的前面；
3. 再看事件自己：落在已经关掉的窗口里（或者这个窗口的 `closeAt` 已经过去）就丢掉，
   返回 `{ accepted: false, reason: 'too-late' }`，`stats().lateDropped` 加一；
4. 落在还开着的窗口里就合进去，返回 `{ accepted: true }`，并追加一条
   `state: 'preliminary'` 的记录。

所以一次 push 可能同时吐出好几条：前面是别的窗口被水位关掉的 `final`，最后一条是这次的
`preliminary`。窗口关闭前后的数值关系是：`final` 的值等于最后一次 `preliminary` 的值。

### 记录形状

```js
{
  seq: 3,                     // 发出来的第几条，从 1 连着涨
  key: 'tenant-a',
  windowStart: 0,
  windowEnd: 1000,
  state: 'preliminary',       // preliminary | final
  values: { count: 2, 'sum:bytes': 30, 'avg:bytes': 15 },
}
```

`values` 的键就是 `aggregations` 里写的那些，顺序也照着配置来；数值由 `lib/agg.js` 算
（`avg` 保留 6 位小数）。

### 留在内存里的窗口

- `flush()`：不管水位走到哪儿，把还开着的窗口都按 `(windowEnd, key)` 排好发 `final`。
  收尾用，之后没有开着的窗口了。
- 关掉的窗口还留着，直到 `watermark >= closedAt + retentionMs` 才整个放掉；放掉之后
  `get()` 查不到、`windows()` 里也没有。清理在 `push` / `advanceTo` / `flush` 里顺手做。
- `stats().emitted` 等于已经发出去的记录条数（也就是最后一条的 `seq`）。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_CONFIG` | 配置不合法：`windowMs` 不是正整数，`watermarkDelayMs` / `allowedLatenessMs` / `retentionMs` 不是非负整数，`aggregations` 空数组或有不认识的项，`advanceTo` 给了非负整数以外的东西。`details.field` 指出是哪个 |
| `ERR_BAD_EVENT` | `key` 空 / 不是字符串，`eventTime` 不是非负整数，`values` 不是对象，聚合要用的字段没给或不是数字。`details.field` 指出是哪个 |

## API

```js
import { createAggregator, DEFAULTS } from './lib/stream.js';

const agg = createAggregator({
  windowMs: 1000,
  watermarkDelayMs: 0,
  allowedLatenessMs: 500,
  retentionMs: 60000,
  aggregations: ['count', 'sum:bytes', 'avg:bytes'],
});

agg.push({ key: 'tenant-a', eventTime: 100, values: { bytes: 10 } });
// -> { accepted: true, emitted: [ { seq, key, windowStart, windowEnd, state, values } ] }

agg.push({ key: 'tenant-a', eventTime: 90, values: { bytes: 1 } });
// -> { accepted: false, reason: 'too-late', emitted: [...] }   （迟到太久时）

agg.advanceTo(1500); // -> { emitted: [...] }
agg.flush();         // -> { emitted: [...] }
agg.stats();         // -> { watermark, maxEventTime, windows, openWindows, closedWindows, emitted, lateDropped }
agg.windows();       // -> [{ key, windowStart, windowEnd, state, closedAt, values }]（按 windowStart、key 排）
agg.get('tenant-a', 0);
// -> 上面那个形状；没这个窗口就是 null
```

配置不给的字段走 `DEFAULTS`。出错一律抛 `AggError`（`lib/errors.js`），按 `code` 分流。
聚合本身（`parseSpec` / `emptyAggregate` / `addValue` / `renderAggregate`）在 `lib/agg.js`
里，已经写好，别改也别绕开。

## demo 跑出来应该长这样

`npm run demo` 里的事件都是写死的，输出每一行都能对上：

```
tideflow demo
[1] 同一个窗口里连着收，边收边更新
    #1 preliminary tenant-a [0,1000) count=1 sum:bytes=10 avg:bytes=10
    #2 preliminary tenant-a [0,1000) count=2 sum:bytes=30 avg:bytes=15
[2] 虽然迟到，但还在宽限期里，补进窗口 0
    #3 preliminary tenant-a [0,1000) count=3 sum:bytes=36 avg:bytes=12
[3] 水位走到宽限期，窗口关掉发 final
    #4 final       tenant-a [0,1000) count=3 sum:bytes=36 avg:bytes=12
    #5 preliminary tenant-b [1000,2000) count=1 sum:bytes=7 avg:bytes=7
[4] 迟到太久，直接丢掉
    没有输出
    lateDropped=1
[5] 收尾：把还开着的都收掉，再统计
    #6 final       tenant-b [1000,2000) count=1 sum:bytes=7 avg:bytes=7
    watermark=1500 windows=2 open=0 closed=2 emitted=6
```
