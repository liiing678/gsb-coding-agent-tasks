# eventpush 起始环境

内部的事件推送网关：几个服务往这里发事件，前端和别的内部服务用 SSE 长连接订阅 topic。
**要写的那块是空的**：`src/hub.js` 里的 `createHub` 现在只会抛 `NotImplementedError`，
其余是骨架、口径和用例。

## 怎么跑

不用 `npm install`，这个仓库没有任何第三方依赖，`package.json` 里也不要加 `dependencies`。

```
npm test                                 # node --test 跑 test/eventpush.test.js
node bin/eventpush.js --config configs/dev.json
```

演示不需要任何外部服务：`bin/eventpush.js` 自己起一个本地 HTTP 服务，连两个 SSE 客户端，
发几个事件，再演示一次断线重连（带 `Last-Event-ID`）。

```
[1] 一个客户端订阅 orders
    <- id=1 order.created {"id":7}
    <- id=2 order.paid {"id":7}
[2] 第二个客户端带 Last-Event-ID: 1 重连
    <- id=2 order.paid {"id":7}
    <- id=3 order.shipped {"id":7}
[3] 发一个没人订阅的 topic
    第一个客户端收到 3 帧，第二个收到 2 帧

-- counters --
eventpush_published_total=4
eventpush_delivered_total=5
eventpush_dropped_total=0
eventpush_disconnected_total=0
eventpush_replay_total=1
eventpush_replay_gap_total=0
eventpush_rejected_total=0
eventpush_publish_rejected_total=0
```

## 目录

| 路径 | 说明 |
|---|---|
| `src/hub.js` | **要你写的部分**：`createHub({...})` 返回 `{ subscribe, publish, close, stats }` |
| `src/sse.js` | 帧编码 `formatFrame({ id, event, data })`（已实现，别改） |
| `src/server.js` | HTTP 那层：`GET /events`（SSE）、`POST /publish`（已实现，别改） |
| `src/errors.js` | `ClosingError` / `SubscriberLimitError` / `NotImplementedError`（已实现，别改） |
| `src/counters.js` | 计数器（已实现，别改） |
| `src/config.js` | 读配置、校验（已实现，别改） |
| `bin/eventpush.js` | 演示入口：起服务、连两个客户端、发事件、演示重连补发 |
| `test/eventpush.test.js` | 用例，现在跑是红的 |
| `test/support/` | 假时钟、接帧的 sink、搭 hub 的小工具 |
| `configs/dev.json` | 演示和默认配置 |

## 接口

```js
createHub({
  config,   // configs/dev.json 里 eventpush 那一段（config.js 已经校验过）
  counters, // src/counters.js
  now,      // 取当前时间，默认 () => Date.now()
  sleep,    // 睡 ms 毫秒，默认 setTimeout；测试会换成假时钟
}) -> { subscribe(subscription), publish(topic, event), close(), stats() }
```

`subscribe` 是**同步**的（订阅生效和补发之间不能留缝），入参：

```js
{
  topics: ['orders'],        // 订阅哪些 topic
  lastEventId: '12',         // 可选；客户端上次收到的帧 id，用来补发
  overflowPolicy: 'drop_oldest', // 可选；不给就用 config.defaultOverflowPolicy
  send: (frame) => {...},    // 把一帧交给这条连接；返回 promise 就等它 resolve 再发下一帧
  close: (reason) => {...},  // 这条订阅被服务端结束的时候回调一次
}
```

返回一个 handle：`{ id, topics, close(reason) }`，客户端自己断开时调 `handle.close('client_gone')`。

`publish(topic, event)` 里的 `event` 是 `{ type, data }`（`data` 会被 JSON 编码进 `data:` 行），
resolve 成 `{ topic, seq, id }`（`id` 就是 `String(seq)`）。关闭之后 publish 要 reject
`ClosingError`。

`close()` 返回一个 promise：所有订阅都处理完了才 resolve；重复调用返回同一个 promise。

`stats()` 返回 `{ subscriptions, buffered, oldestSeq, newestSeq, counters }`。

## 帧长什么样（src/sse.js 已经实现好了）

```
id: 3
event: order.created
data: {"id":7}

```

`event:` 取 `event.type`，`data:` 是 `event.data` 的 JSON；找不到 type 就用 `message`。

## 配置字段

| 字段 | 说明 |
|---|---|
| `eventpush.perConnBuffer` | 每条订阅排队等着发的帧数上限（正在发的那一帧不算） |
| `eventpush.defaultOverflowPolicy` | 缓冲满了怎么办：`drop_oldest`（丢最旧的）或 `disconnect`（断开这条订阅） |
| `eventpush.replayWindow` | 每个 hub 保留最近多少条事件，用来给断线重连补发 |
| `eventpush.maxSubscriptions` | 同时最多多少条订阅 |
| `eventpush.drainTimeoutMs` | 关闭时最多等每条订阅写多久 |

## 口径

### 发布与顺序

- `seq` 全局单调递增，从 1 开始，**在 publish 调用的那一刻同步分配**：先调的号小，
  后调的号大，中间不能因为 await 插队而乱序。
- 一条订阅收到的事件，顺序必须和 publish 的顺序一致，不能乱序、不能重复：
  客户端不会在收到第 N 条之前先收到第 N+1 条。
- `publish` 只负责把帧塞进队列，**不等任何客户端**：一个读得慢的客户端不能把 publish
  卡住，也不能影响别的订阅者收事件。

### 缓冲与背压

- 每条订阅自己的队列上限是 `perConnBuffer`；满了按这条订阅的 `overflowPolicy` 处理。
- `drop_oldest`：把队列里最旧的一帧丢掉（发 `eventpush_dropped_total`），新帧照样进队。
  已经在发的那一帧不算队列里的，不会被丢。
- `disconnect`：直接断开这条订阅（`close('overflow')`、发 `eventpush_disconnected_total`），
  断开之后不再往它发帧。
- 发送循环每取一帧就调一次 `send(frame)`；`send` 返回 promise 的话等它 resolve 再发下一帧。
  `send` 抛错或者 reject，就断开这条订阅（`close('send_failed')`）。

### 断线补发

- 每个 hub 保留最近 `replayWindow` 条已发布事件（含 topic），越界的从最旧那头丢。
- 订阅带了 `lastEventId` 就补发：窗口里 `seq > lastEventId`、并且 topic 在订阅范围内的，
  按原顺序补一遍，每条只发一次。
- 补发和实时事件走同一条队列，补发的帧先排进去，所以补发期间新发布的事件排在补发后面，
  不会插到中间，也不会重复。
- `lastEventId` 比窗口里最老那条还老（中间已经有洞了），先发一帧
  `event: replay_gap`，`data` 是 `{ requested, oldest }`（要的号、窗口里最老的号），
  再把窗口里有的补上。窗口是空的就不发 gap。
- 补发的帧不受 `perConnBuffer` 限制（窗口本身有上限，一次补发是有限的一批）；
  订阅建立之后的实时帧才受它约束。

### 关闭

- `close()` 之后：`subscribe` 抛 `ClosingError`、`publish` reject `ClosingError`
  （计 `eventpush_publish_rejected_total`），不能悄悄把事件丢掉。
- 已经在队列里的事件要写完：每条订阅最多等 `drainTimeoutMs`，等到了还没写完就断开它
  （`close('drain_timeout')`、发 `eventpush_disconnected_total`）；写完了的按
  `close('closed')` 正常收尾。
- 所有订阅都处理完 `close()` 才 resolve；重复调用返回同一个 promise。
- `close()` 和 `publish` / `subscribe` 并发调用不能 panic、不能死锁。

### 计数器

名字固定，别改名、也别加新的：

| 名字 | 什么时候加 |
|---|---|
| `eventpush_published_total` | 每次 `publish()` 进来加一 |
| `eventpush_delivered_total` | 成功交给某个订阅者的帧数（补发的也算） |
| `eventpush_dropped_total` | 缓冲满被丢掉的帧数（`drop_oldest`） |
| `eventpush_disconnected_total` | 服务端主动断开的订阅数（`overflow` / `send_failed` / `drain_timeout`） |
| `eventpush_replay_total` | 补发出去的事件帧数（不含 `replay_gap`） |
| `eventpush_replay_gap_total` | 发出去的 `replay_gap` 帧数 |
| `eventpush_rejected_total` | `subscribe` 被拒的次数（订阅数到上限、或者正在关闭） |
| `eventpush_publish_rejected_total` | 关闭之后被拒的 `publish` 次数 |

客户端自己断开（`handle.close('client_gone')`）不算"被服务端断开"，不加那个计数。

## 自检

`npm test` 全绿就算过关，`test/eventpush.test.js` 里每条用例的注释写了它在验什么。

`configs/dev.json` 和 `test/` 下的用例是评测用的，不要改、不要补、不要删。
