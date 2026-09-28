# flate

原始 DEFLATE 解压（stored / 固定霍夫曼 / 动态霍夫曼三种块）、zlib 包装与 Adler-32 校验。
只用 Node 标准库，`node >= 20`。

```
flate/
├── lib/
│   ├── flate.js    inflateRaw / inflateZlib / adler32      ← 还没实现
│   └── errors.js   FlateError 与全部错误码
├── test/           inflate / zlib 两组用例
├── scripts/demo.mjs 手工过一遍的演示脚本
└── package.json    npm test / npm run demo
```

```
npm test        # 10 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 位与字节

DEFLATE 的位流是**低字节序**：普通字段（`BFINAL`、`BTYPE`、`HLIT`、附加位……）都是低位在前，
先读到的是最低有效位；**霍夫曼码字反过来**，是按高位在前拼出来的，解的时候从码字的最高位开始往
树里走。stored 块要跳到下一个字节边界再读长度和数据。

### 块的类型

每个块开头 1 位 `BFINAL` + 2 位 `BTYPE`：

- `00` stored：跳到字节边界，读 `LEN`、`NLEN` 两个 16 位小端整数，**`LEN ^ 0xffff` 必须等于
  `NLEN`**，对不上就是 `ERR_BAD_LENGTH`；然后原样拷 `LEN` 个字节。
- `01` 固定霍夫曼表：字面/长度表的码长是 0..143 → 8 位、144..255 → 9 位、256..279 → 7 位、
  280..287 → 8 位；距离表是 32 个 5 位码，码 30 / 31 在口径里非法。
- `10` 动态霍夫曼表：先读 `HLIT = bits(5) + 257`（257..288）、`HDIST = bits(5) + 1`（1..32）、
  `HCLEN = bits(4) + 4`（4..19）；码长表的 19 个码长按 `16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4,
  12, 3, 13, 2, 14, 1, 15` 这个顺序各读 3 位（剩下的补 0）。用这张码长表读出 `HLIT + HDIST` 个
  码长：符号 0..15 就是码长本身，16 = 把**前一个**码长再复制 3..6 次（前面没有码长就用 16 是
  `ERR_BAD_LENGTH`），17 = 补 3..10 个 0，18 = 补 11..138 个 0；重复次数越过总数也是
  `ERR_BAD_LENGTH`。
- `11`：保留值，`ERR_BAD_BLOCK`。

码表本身的口径：**超订**（前缀撞上）一律 `ERR_BAD_HUFFMAN`；**不完整**（有没被码字占用的分支）
只有「整张表恰好只有一个码」时才允许，否则 `ERR_BAD_HUFFMAN`。字面/长度表里必须有 256（块结束
符），没有就是 `ERR_BAD_HUFFMAN`；距离表允许整张都是 0（空表），真去解距离时才报
`ERR_BAD_HUFFMAN`。读出 256 就是这个块结束；等 `BFINAL = 1` 的块也结束后，解压就算完，
**raw 流后面还有没有多余字节都不看**。

### 长度与距离

长度码 257..285 走这两张表（附加位也是低位在前读）：

| 长度码 | 257 | 258 | 259 | 260 | 261 | 262 | 263 | 264 | 265 | 266 | 267 | 268 | 269 | 270 | 271 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 基数 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 13 | 15 | 17 | 19 | 23 | 27 |
| 附加位 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 1 | 1 | 2 | 2 | 2 |

| 长度码 | 272 | 273 | 274 | 275 | 276 | 277 | 278 | 279 | 280 | 281 | 282 | 283 | 284 | 285 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 基数 | 31 | 35 | 43 | 51 | 59 | 67 | 83 | 99 | 115 | 131 | 163 | 195 | 227 | 258 |
| 附加位 | 2 | 3 | 3 | 3 | 3 | 4 | 4 | 4 | 4 | 5 | 5 | 5 | 5 | 0 |

286 / 287 这两个码在固定表里占着码位但非法，解到就是 `ERR_BAD_LENGTH`。

距离码 0..29 同理：基数是
`1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
3073, 4097, 6145, 8193, 12289, 16385, 24577`，
附加位是 `0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
13, 13`。距离码 30 / 31（动态表里解出 ≥ 30 的符号也算）是 `ERR_BAD_DISTANCE`。

复制的时候**距离不能超过已经解出来的字节数**，超了 `ERR_BAD_DISTANCE`；距离小于长度是合法的
重叠复制（典型例子：一个 `'a'` 后面跟「长度 3、距离 1」，解出来是 `aaaa`），要一个字节一个字节
地往回抄，不能先把源片段切出来再整体拼。

### zlib 包装

`inflateZlib` 收的是 RFC 1950 的流：2 个字节的头 + DEFLATE 数据 + 4 个字节的大端 Adler-32。

- 头不够 2 个字节、或者 `CM`（低 4 位）不是 `8`、或者 `CINFO`（高 4 位）大于 7、或者
  `((CMF << 8) | FLG) % 31 !== 0`、或者 `FDICT`（`FLG` 的 0x20 位）被置上 → 全是 `ERR_BAD_ZLIB`。
- DEFLATE 数据结束后**必须正好剩 4 个字节**的 Adler-32：不够 → `ERR_TRUNCATED`，还多 → `ERR_BAD_ZLIB`。
- 校验值对不上 → `ERR_CHECKSUM`。
- `adler32(bytes, seed = 1)`：两个 16 位累加器各自对 65521 取模，`B` 在高 16 位、`A` 在低 16 位，
  返回值是 `((B << 16) | A) >>> 0`。空输入就是 `1`。

### 入参

`inflateRaw` / `inflateZlib` / `adler32` 只收 `Uint8Array`（`Buffer` 也是它），别的（字符串、数组、
`ArrayBuffer`、`null`、数字、对象）一律 `ERR_BAD_INPUT`。输入不够读（包括空输入）是
`ERR_TRUNCATED`。解出来的字节是新 `Uint8Array`，不要把自己的内部缓冲交出去。

## API

| 入口 | 说明 | 错误码 |
|---|---|---|
| `inflateRaw(input)` | 解开原始 DEFLATE 流（一到多个块，最后一个块 `BFINAL = 1`），返回 `Uint8Array` | `ERR_BAD_INPUT` / `ERR_TRUNCATED` / `ERR_BAD_BLOCK` / `ERR_BAD_HUFFMAN` / `ERR_BAD_LENGTH` / `ERR_BAD_DISTANCE` |
| `inflateZlib(input)` | 先剥 zlib 头，再解开 DEFLATE 数据，最后校验 Adler-32 | 上面那些，加上 `ERR_BAD_ZLIB` / `ERR_CHECKSUM` |
| `adler32(bytes, seed = 1)` | Adler-32，返回 32 位无符号整数 | `ERR_BAD_INPUT` |

| 错误码 | 什么时候抛 |
|---|---|
| `ERR_BAD_INPUT` | 入参不是 `Uint8Array` |
| `ERR_TRUNCATED` | 位读着读着输入没了、stored 块的数据不够、zlib 尾部的 Adler-32 不完整 |
| `ERR_BAD_BLOCK` | `BTYPE = 3` |
| `ERR_BAD_HUFFMAN` | 码表超订 / 不完整 / 空表却要用 / 字面长度表里没有 256 / 码字不在表里 |
| `ERR_BAD_LENGTH` | stored 的 `LEN` / `NLEN` 对不上、长度码 286 / 287、动态表的码长重复次数越界或前面没有码长可复制 |
| `ERR_BAD_DISTANCE` | 距离码 30 / 31、距离比已解出来的字节还远 |
| `ERR_BAD_ZLIB` | zlib 头不合法（CM / CINFO / FCHECK / FDICT）、DEFLATE 数据后面还有多余字节 |
| `ERR_CHECKSUM` | 尾部 Adler-32 和实际数据对不上 |

## demo 跑出来应该长这样

```
flate demo
  stored.bytes 137
  stored.ok true
  fixed.bytes 16
  fixed.ok true
  dynamic.bytes 16
  dynamic.ok true
  zlib.bytes 22
  zlib.text flate demo flate demo f
  adler32.empty 1
  adler32.Wikipedia 300286872
  corrupted.code ERR_CHECKSUM
  truncated.code ERR_TRUNCATED
```