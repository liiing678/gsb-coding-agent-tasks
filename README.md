# cidrroute

一张内存里的 CIDR 前缀表：解析地址和前缀、最长前缀匹配、按值聚合。IPv4 和 IPv6 走同一套代码，
只用 Node 标准库，没有第三方包，`node >= 20`。

```
cidrroute/
├── lib/
│   ├── cidrroute.js   地址/前缀解析与前缀表内核   ← 还没实现
│   └── errors.js      CidrError 与全部错误码
├── test/              prefix / table 两组用例
├── scripts/demo.mjs   手工过一遍的演示脚本
└── package.json       npm test / npm run demo
```

```
npm test        # 13 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 地址与前缀

- 地址一律是字符串：IPv4 四段十进制，每段 0-255、不写前导零；IPv6 是标准写法，每组 1-4 位
  十六进制，允许在任意位置用**一次** `::` 压缩连续的全零组（至少省掉一组），十六进制大小写都收，
  但不认内嵌 IPv4 的写法。地址字符串不能是空串，首尾和中间都不能有空白。
- `parseAddress(text)` → `{ family, value }`：`family` 是 4 或 6，`value` 是 `BigInt`
  （v4 是 32 位、v6 是 128 位，按网络字节序拼起来的那个整数）。
- 前缀写成 `地址/长度`：长度是不带前导零的十进制，v4 最多 32、v6 最多 128；
  **主机位必须是 0**，`10.1.2.3/8` 这种不合法。
- `parsePrefix(text)` → `{ family, bits, value, text }`，`value` 是掩码之后的网络地址，
  `text` 是规范化写法：IPv4 按四段十进制补齐，IPv6 按 RFC 5952 压缩（最长的一段连续全零组
  写成 `::`，一样长取靠左的那段；全零写 `::`；十六进制小写、不补前导零）。
  所以 `2001:0DB8:0000::/32` 的 `text` 是 `2001:db8::/32`。
- `formatAddress(family, value)` 把 `value` 写回同样的字符串写法。

### 前缀表

`createTable()` 出来的表里每一格是 `{ 前缀, 值 }`，值是调用方自己给的任意 JavaScript 值
（对象、数组、字符串、`null` 都行，就是不能是 `undefined`）。同一个前缀再 `insert` 一次是覆盖。
两个家族互不干扰：IPv4 的前缀不会被 IPv6 的地址匹配到，反之也一样。

- `insert(prefix, value)` → `{ prefix, replaced }`。`prefix` 既可以是字符串，也可以是
  `parsePrefix` 的返回值；返回的 `prefix` 是**规范化之后**的写法，`replaced` 表示这个前缀原本就有。
- `exact(prefix)` → `{ prefix, value }` 或者 `null`（表里没这个前缀）；`has(prefix)` 就是它不等于 `null`。
- `remove(prefix)` → 布尔：真删掉了一个条目才是 `true`，本来就没有是 `false`；删完只剩空壳的中间节点顺手剪掉。
- `lookup(address)` → `{ prefix, value }` 或者 `null`：**最长前缀匹配**，命中的前缀是表里真实存在的
  条目，一个都没命中就是 `null`（`0.0.0.0/0`、`::/0` 只是普通条目，没有特殊待遇）。
- `size()` → 表里条目数。
- `entries()` → 全部条目，按**家族（4 在 6 前）、网络地址升序、掩码长度升序**排好；
  同一地址上短前缀在前，也就是祖先排在子孙前面。
- `aggregate()` → 这次少掉的条目数（聚合前后的 `size()` 之差）：两个兄弟前缀都在表里、都是叶子、
  值相等，就合成它们的父前缀；父前缀本来有值的话，值必须跟它们相等才合得动。合完接着往上试，
  一直合到不能合为止。值相等的口径是「规范化之后文本一样」：对象按键名排序、数组保持顺序、
  `NaN` 算相等。

## API

```js
import { createTable, parseAddress, parsePrefix, formatAddress } from './lib/cidrroute.js';

const table = createTable();
table.insert('10.0.0.0/8', { via: 'backbone' });
table.insert('10.1.4.0/22', { via: 'lab' });

table.lookup('10.1.4.9');            // -> { prefix: '10.1.4.0/22', value: { via: 'lab' } }
table.lookup('10.1.9.9');            // -> { prefix: '10.0.0.0/8', value: { via: 'backbone' } }
table.exact('10.1.4.0/22');          // -> { prefix: '10.1.4.0/22', value: { via: 'lab' } }
table.has('10.1.4.0/22');            // -> true
table.remove('10.1.4.0/22');         // -> true
table.lookup('10.1.4.9').prefix;     // -> '10.0.0.0/8'

parsePrefix('2001:0DB8:0000::/32').text;   // -> '2001:db8::/32'
parseAddress('10.1.2.3');                  // -> { family: 4, value: 0x0a010203n }
formatAddress(6, 1n);                      // -> '::1'

const agg = createTable();
agg.insert('10.0.0.0/9', 'east');
agg.insert('10.128.0.0/9', 'east');
agg.aggregate();                     // -> 1
agg.entries();                       // -> [{ prefix: '10.0.0.0/8', value: 'east' }]
```

出错一律抛 `CidrError`（`lib/errors.js`），按 `code` 分流：

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_ADDRESS` | 地址不是非空无空白的字符串、IPv4 段数不对／有前导零／超 255、IPv6 组数不对／有非法十六进制／`::` 用错 |
| `ERR_BAD_PREFIX` | 前缀不是非空无空白的字符串、没有或多于一个 `/`、掩码长度不是不带前导零的十进制或超出上限、主机位不是 0、给的对象形状不对 |
| `ERR_BAD_ARGUMENT` | `insert` 没给值（`undefined`） |

## demo 跑出来应该长这样

```
cidrroute demo
  parsed 10.1.0.0/16 bits=16
  parsed6 2001:db8::/32
  lookup 10.1.4.9 10.1.4.0/22 -> {"via":"lab"}
  lookup 10.1.9.9 10.1.0.0/16 -> {"via":"office"}
  lookup 10.9.9.9 10.0.0.0/8 -> {"via":"backbone"}
  lookup 172.16.0.1 null
  lookup 2001:db8:1::1 2001:db8::/32 -> {"via":"dc6"}
  exact /16 10.1.0.0/16 -> {"via":"office"}
  exact 10.0.0.0/16 null
  entries ["10.0.0.0/8","10.1.0.0/16","10.1.4.0/22","192.168.0.0/16","2001:db8::/32"]
  size 5
  remove /22 true
  lookup 10.1.4.9 again 10.1.0.0/16 -> {"via":"office"}
  remove /22 again false
  beforeAggregate ["10.0.0.0/10","10.64.0.0/10","10.128.0.0/10","10.192.0.0/10"]
  aggregate 2
  afterAggregate ["10.0.0.0/9","10.128.0.0/9"]
  aggLookup 10.200.1.1 10.128.0.0/9 -> {"via":"west"}
```
