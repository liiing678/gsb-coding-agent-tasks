# wirecodec

自己那套变长整数二进制编解码：字段编号、zigzag、未知字段原样保留、永远输出最短形式。
下游的版本可能比我们新，也可能有人手写过这个格式，所以不管收到什么，读得出来就得不丢东西，
写出去就得是同一份字节。只用 Node 标准库，没有第三方包，`node >= 20`。

```
wirecodec/
├── lib/
│   ├── wirecodec.js   createCodec 本体              ← 还没实现
│   └── errors.js      CodecError 与全部错误码
├── test/              encode / decode 两组用例
├── scripts/demo.mjs   手工过一遍的演示脚本
└── package.json       npm test / npm run demo
```

```
npm test        # 17 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### schema

`createCodec({ schema })`，`schema` 是一串字段：

```js
{ id: 1, name: 'seq', type: 'uint32', repeated: false, required: false }
```

- `id` 是 **1..2^29-1** 的整数，不能重复（`1 << 29` 都不行）。
- `name` 是非空字符串，就是消息对象里的键。
- `type` 只有五种：`uint32`、`int32`、`bool`、`string`、`bytes`。
- `repeated` 默认 `false`，表示这个键是数组、可以出现很多条；
  `required` 默认 `false`，表示编解码时这个字段必须在。
  两个都标 `true` 不合法（必填的是数组没什么意义，这一版不做）。

### 线上的字节

每个字段 = **key** + 载荷。key 是 `(id << 3) | wireType` 的变长整数。

| wireType | 名字 | 载荷 |
|---|---|---|
| 0 | varint | 变长整数本身 |
| 1 | fixed64 | 8 个字节，直接跳过 |
| 2 | length-delimited | 长度（变长整数）+ 内容 |
| 5 | fixed32 | 4 个字节，直接跳过 |

字段类型对应哪个 wireType：`uint32` / `int32` / `bool` 是 0，`string` / `bytes` 是 2。

- `uint32`：0..2^32-1，直接写。
- `int32`：先 zigzag 再写：`(n << 1) ^ (n >> 31)`，按 32 位无符号回绕；
  解回来是 `(raw >>> 1) ^ -(raw & 1)`，按 32 位有符号算。
- `bool`：写 `1` / `0`；读的时候**只认 0 和 1**，别的值算坏值。
- `string`：UTF-8；编码用 `TextEncoder`，解码用 `TextDecoder` 的 **fatal 模式**
  （`fatal: true`），碰到非法 UTF-8 就报错，别拿替换字符糊过去。
- `bytes`：原始字节，长度前缀同上。

### 写的时候

- 字段**按 id 升序**输出，跟 schema 里的顺序、跟消息对象里的键序都没关系。
  同一个 `repeated` 字段的多条按数组顺序挨着写。
- 值是 `undefined` 或者 `null` 就当没给：跳过，一个字节都不写。
- 变长整数永远写**最短形式**（0 就是 `00`，不是 `80 00`）。
- `required` 的字段没给 → `ERR_MISSING_REQUIRED`（`details` 里给 `name` 和 `id`）。
- 值不在类型范围内、或者类型本身就不对（比如给 `bytes` 传数组）→ `ERR_BAD_VALUE`。
- 第二个参数可以带 `{ unknownFields }`：这些条目是**别处解出来的、我们不认识的字段**，
  把它们跟已知字段一起按 id 升序排好原样写出去（`raw` 里已经是完整的 key + 载荷）。

### 读的时候

- id 在 schema 里：按字段类型解，wireType 跟 schema 对不上 → `ERR_BAD_WIRE_TYPE`。
- id 不在 schema 里：**原样留着**，丢进返回值里的 `unknownFields`，
  每条是 `{ id, wireType, raw }`，`raw` 是这一段完整的字节（`key` 到载荷末尾，拷贝一份）。
  wireType 是 1 就跳 8 个字节、是 5 就跳 4 个字节、是 2 就按长度前缀跳、是 0 就把那个变长整数吃掉。
- `repeated` 的字段收成数组；不是 `repeated` 的字段出现多次时**最后一条赢**。
- 没出现的字段**不要**放进结果对象里（不会给你补零）。
- 解完再查一遍 `required`：缺了 → `ERR_MISSING_REQUIRED`。

读到的变长整数**可以不是最短形式**（外面手写的工具可能写成 `80 00`），照解不误，
但重编码的时候必须收回最短形式——这是这套东西能被拿来对字节的前提。

### 什么样的字节算坏

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_ARGS` | `createCodec` 的配置不是对象；`encode` 的消息不是普通对象、第二个参数不对、`unknownFields` 里的条目不对；`decode` 收到的不是 `Uint8Array` |
| `ERR_BAD_SCHEMA` | schema 不是数组、字段不是对象、id 不合法或者重复、name 是空、type 不认识、`repeated` / `required` 不是布尔或者同时为真 |
| `ERR_BAD_VALUE` | 值的类型或者范围不对（`uint32` 越界、`int32` 越界、布尔不是布尔、`bytes` 不是 `Uint8Array`……），以及解到的布尔不是 0/1 |
| `ERR_BAD_WIRE_TYPE` | key 里的字段号是 0、wireType 是 3/4/6/7、已知字段的 wireType 跟 schema 对不上 |
| `ERR_TRUNCATED` | 变长整数读到一半没了、长度前缀说后面还有很多字节、fixed32 / fixed64 不够长 |
| `ERR_VARINT_OVERFLOW` | 变长整数超过 5 个字节，或者第 5 个字节超出 32 位能表示的范围 |
| `ERR_BAD_UTF8` | `string` 字段的内容不是合法 UTF-8 |
| `ERR_MISSING_REQUIRED` | 编码时必填字段没给，解码时必填字段没出现 |

## API

```js
import { createCodec, WIRE_TYPES } from './lib/wirecodec.js';

const codec = createCodec({
  schema: [
    { id: 1, name: 'seq', type: 'uint32' },
    { id: 2, name: 'label', type: 'string' },
    { id: 3, name: 'tally', type: 'uint32', repeated: true },
    { id: 6, name: 'note', type: 'bytes', required: true },
  ],
});

codec.encode({ seq: 150, note: Uint8Array.from([0x0a]) });   // -> Uint8Array
const { value, unknownFields } = codec.decode(bytes);
codec.encode(value, { unknownFields });                      // 带上不认识的字段再写回去
codec.fields();                                             // schema 的拷贝，按声明顺序
WIRE_TYPES;                                                 // { VARINT: 0, FIXED64: 1, BYTES: 2, FIXED32: 5 }
```

出错一律抛 `CodecError`（`lib/errors.js`），按 `code` 分流。

## demo 跑出来应该长这样

`npm run demo` 里的消息和字节都是写死的，输出每一行都能对上：

```
wirecodec demo
  wire types: varint=0 fixed64=1 bytes=2 fixed32=5
  encode 08 96 01 10 03 1a 02 68 69 32 01 0a
  decode seq=150 delta=-2 label="hi" note=0a
  unknown 9/wire0 8/wire5
  re-encode 08 96 01 10 03 1a 02 68 69 32 01 0a 45 78 56 34 12 48 96 01
  sloppy 08 80 00 32 01 0a -> seq=0 note=0a
  canonical 08 00 32 01 0a
```
