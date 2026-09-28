# lzpack

一个自己写的 LZSS 打包器：窗口里找最长的重复，用两字节的「距离 + 长度」替掉。
格式和搜索规则都钉死了，**同样的输入必须压出同样的字节**，解压的时候还要能把被改过的数据当场认出来。
只用 Node 标准库，没有第三方包，`node >= 20`。

```
lzpack/
├── lib/
│   ├── lzpack.js       compress / decompress / checksum   ← 还没实现
│   └── errors.js       PackError 与全部错误码
├── test/               roundtrip / format 两组用例
├── scripts/demo.mjs    手工过一遍的演示脚本
└── package.json        npm test / npm run demo
```

```
npm test        # 15 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 打包格式

包 = **12 字节的头** + 载荷。

| 偏移 | 长度 | 内容 |
|---|---|---|
| 0 | 4 | magic `LZP1`（`4c 5a 50 31`） |
| 4 | 4 | 原始长度，uint32 小端 |
| 8 | 4 | 原始数据的校验和，uint32 小端 |

校验和是 FNV-1a 32 位：`hash = 0x811c9dc5`，逐字节 `hash = (hash ^ byte) * 0x01000193`，
乘法按 32 位无符号回绕（空数据的校验和就是 `0x811c9dc5`）。

载荷按**一组最多 8 个条目**排：每组第一个字节是标志字节，之后跟着这一组的条目。
标志字节的 **bit0 是这一组的第 1 个条目**、bit1 是第 2 个，依此类推；用不到的位补 `0`。

- 标志位是 `1`：**字面量**，后面 1 个字节就是原文。
- 标志位是 `0`：**匹配**，后面 2 个字节（小端）拼成一个 uint16 `value`：
  低 12 位 `value & 0xfff` 是 `距离 - 1`（所以距离是 1..4096），
  高 4 位 `value >>> 12` 是 `长度 - 3`（所以长度是 3..18）。

```
value = ((长度 - 3) << 12) | (距离 - 1)
```

### 压缩时怎么挑匹配

`compress` 是贪心的，从前往后一次一个条目，**不做延迟匹配**（不看下一个位置是不是更划算）：

1. 站在当前位置 `p`，把往前最多 **4096 字节**（`DEFAULTS.window`）里的**每一个位置**都当候选
   —— 不管那个位置当初是字面量还是被某个匹配盖住的，都算候选。
2. 每个候选能对上的最长前缀就是它的匹配长度，上限 **18 字节**（`DEFAULTS.maxMatch`）。
3. 挑**最长**的那个；长度一样时挑**离当前更近**的（距离小的那个）。
4. 最长也就凑到 **3 字节**（`DEFAULTS.minMatch`）以下，就不匹配，老老实实写字面量。
5. 匹配就按匹配长度跳过，字面量就前进 1 个字节，然后重复。

`DEFAULTS` 是 `{ window: 4096, minMatch: 3, maxMatch: 18 }`，就这么几个数，
不要做成可配置的（格式里也就塞得下这个范围）。

### 解压时怎么认

从载荷里一组一组读，读到输出的字节数够上头部写的原始长度就停。中途任何一条对不上都要抛
`ERR_CORRUPT`：

- 标志字节或者条目读到一半载荷就没了；
- 匹配的距离比**已经解出来的字节数**还大（没东西可抄）；
- 匹配的长度会让输出超过头部写的原始长度；
- 原始长度已经凑够，载荷后面却还剩着字节；
- 最后算出来的校验和跟头部记的对不上。

头部本身不成立（不足 12 字节、magic 不对）是 `ERR_BAD_HEADER`。
另外头部写的原始长度超过 64MiB（`1 << 26`）也直接判 `ERR_CORRUPT`，别真去分配。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_ARGS` | `compress` / `decompress` / `checksum` 收到不是 `Uint8Array` 的东西 |
| `ERR_BAD_HEADER` | 不足 12 字节，或者 magic 不是 `LZP1` |
| `ERR_CORRUPT` | 载荷读不通、长度/距离越界、有尾巴、原始长度大得离谱、校验和对不上 |

## API

```js
import { compress, decompress, checksum, DEFAULTS } from './lib/lzpack.js';

compress(new Uint8Array([1, 2, 3]));   // -> Uint8Array（12 字节头 + 载荷）
decompress(compress(data));            // -> 和 data 一样的 Uint8Array（是新的一份）
checksum(data);                        // -> FNV-1a 32 位，0..0xffffffff
DEFAULTS;                              // -> { window: 4096, minMatch: 3, maxMatch: 18 }
```

出错一律抛 `PackError`（`lib/errors.js`），按 `code` 分流。

## demo 跑出来应该长这样

`npm run demo` 里的输入都是写死的，输出每一行都能对上：

```
lzpack demo
  defaults: window=4096 minMatch=3 maxMatch=18
  text 89 -> 68 字节
  头部 4c 5a 50 31 59 00 00 00 cd 0b 61 e3
  载荷 ff 74 68 65 20 71 75 69 63 ff 6b 20 ...
  校验和 e3610bcd
  解压回来一致：true
  小样本 9 -> 17 字节：4c 5a 50 31 09 00 00 00 7d 6d 6d fd 05 41 00 40 42
```
