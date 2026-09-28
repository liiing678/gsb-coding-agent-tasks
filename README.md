# tscodec

时序点 `[{ t, v }]` 的压缩编解码：时间戳走 delta-of-delta 的变长整数，值跟上一条异或之后
只留有效位，每块再挂一个 CRC32 兜底。只用 Node 标准库，没有第三方包，`node >= 20`。

```
tscodec/
├── lib/
│   ├── tscodec.js     encodeSeries / decodeSeries / stats   ← 还没实现
│   └── errors.js      TscodecError 与全部错误码
├── test/              format / roundtrip 两组用例
├── scripts/demo.mjs   手工过一遍的演示脚本
└── package.json       npm test / npm run demo
```

```
npm test        # 14 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 输入

一条时序点是 `{ t, v }`：`t` 是毫秒时间戳，必须是**安全整数**；`v` 是有限数
（`NaN`、`±Infinity` 直接拒）。整条序列的 `t` 必须**严格递增**。空数组合法（编出来只有头）。

### 字节格式

一律大端。头 11 个字节：

| 偏移 | 长度 | 内容 |
|---|---|---|
| 0 | 4 | magic `TSCO`（`0x54 0x53 0x43 0x4F`） |
| 4 | 1 | 版本，固定 `1` |
| 5 | 2 | `blockSize`，正整数（默认 120，上限 65535） |
| 7 | 4 | 总条数，无符号 32 位 |

后面按 `blockSize` 切块，一块接一块（最后一块可以不满；`blockSize` 是每块的上限，
不是每块都得塞满）。每块：

| 长度 | 内容 |
|---|---|
| 2 | 本块条数，1..blockSize |
| 8 | 本块第一条的 `t`，有符号 64 位补码 |
| 8 | 本块第一条的 `v`，IEEE754 双精度 |
| ? | 时间戳段：本块第 2..n 条各一个变长整数 |
| ? | 值段：本块第 2..n 条各一段 |
| 4 | CRC32，覆盖本块从「条数」到「值段」结束（不含这 4 个字节自己） |

**时间戳段**：块内第 i 条（i ≥ 2）编 `dod = (t_i − t_{i−1}) − (t_{i−1} − t_{i−2})`；块内第二条
没有「上上个」，把上一个 delta 当成 0，于是它的 `dod` 就是自己的 delta。`dod` 先 zigzag
（`dod >= 0` 就写成 `2 * dod`，否则 `-2 * dod - 1`），再写成 LEB128 变长整数：每字节低 7 位
是数据、最高位表示「后面还有」。解的时候加回去就行。

**值段**：把这一条的 `v` 和**块内上一条**（块内第一条用块头里那个 `v`）各取 64 位再异或：

- 异或结果是 0 → 一个字节 `0x00`；
- 否则 → `0x01` + 一个字节「前导零个数 L」（0..63）+ 一个字节「有效位数 − 1」
  （有效位数 = `64 − L − T`，T 是尾部零的个数，落在 1..64）+ `ceil(有效位数 / 8)` 个字节，
  把 `异或值 >> T` 之后的有效位按大端写进去。

**CRC32** 用 IEEE 那套：多项式 `0xEDB88320` 反射、初值 `0xFFFFFFFF`、最后取反。

### 一致性

`decodeSeries` 要把头、每块的条数、条数总和、每个块的 CRC 都核一遍，任何一处对不上就报错，
不允许「尽力解出一半」。同一份输入、同一个 `blockSize` 编两次，得到的字节必须一模一样。

## API

```js
import { decodeSeries, encodeSeries, stats } from './lib/tscodec.js';

const points = [{ t: 1700000000000, v: 23.5 }, { t: 1700000001000, v: 23.5 }];

const bytes = encodeSeries(points);          // -> Uint8Array
encodeSeries(points, { blockSize: 10 });     // 每块最多 10 条

decodeSeries(bytes);   // -> { points: [{ t, v }, ...], blocks: 1 }
stats(bytes);          // -> { points, blocks, bytes, headerBytes, timestampBytes, valueBytes, overheadBytes }
```

`stats` 是给「压得怎么样」看的：`headerBytes` 固定 11，`timestampBytes` / `valueBytes` 是各块
两段加起来的字节数，`overheadBytes` 是剩下的（每块 18 个字节的块头 + 4 个字节的 CRC），
四项相加正好是 `bytes`。

出错一律抛 `TscodecError`（`lib/errors.js`），按 `code` 分流：

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_INPUT` | `points` 不是数组、元素不是 `{ t, v }`、`t` 不是安全整数、`v` 不是有限数、`t` 不是严格递增；或者 `decodeSeries` / `stats` 喂进来的不是 `Uint8Array`（`Buffer` 是它的子类，可以用） |
| `ERR_BAD_OPTIONS` | `blockSize` 不是 1..65535 的整数 |
| `ERR_BAD_HEADER` | magic 或版本不对、`blockSize` 是 0、块条数不在 1..blockSize 里、条数跟头里对不上、尾部有多余字节、值的标记字节不认得 |
| `ERR_TRUNCATED` | 字节不够读完头 / 块头 / 变长整数 / 值段 / CRC |
| `ERR_CHECKSUM` | 某个块的 CRC 对不上 |

## demo 跑出来应该长这样

```
tscodec demo
  bytes 52
  header 5453434f01007800000006
  stats {"points":6,"blocks":1,"bytes":52,"headerBytes":11,"timestampBytes":8,"valueBytes":11,"overheadBytes":22}
  points 6
  blocks 1
  first {"t":1700000000000,"v":23.5}
  last {"t":1700000006000,"v":23}
  reencode true
  corrupted ERR_CHECKSUM
  constantBytes 232
  constantStats {"points":100,"blocks":1,"bytes":232,"headerBytes":11,"timestampBytes":100,"valueBytes":99,"overheadBytes":22}
  constantDecoded 100
```
