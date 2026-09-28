# matchgrid

多模式匹配：一堆关键词丢进去把自动机建好，然后在长文本上找它们出现过的每一个位置——
重叠的、同一个位置长短都命中的、一块一块喂进来还被切开的字符，都得报对。
只用 Node 标准库，没有第三方包，`node >= 20`。

```
matchgrid/
├── lib/
│   ├── matchgrid.js   createMatcher / createScanner / scan   ← 还没实现
│   └── errors.js      MatchgridError 与全部错误码
├── test/              scan / stream 两组用例
├── scripts/demo.mjs   手工过一遍的演示脚本
└── package.json       npm test / npm run demo
```

```
npm test        # 12 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 关键词表

`createMatcher(patterns, { ignoreCase = false, maxMatches } = {})`

- `patterns` 得是**非空数组**，里面每条都得是**非空字符串**，而且**不能重样**（重样的报错——
  不然同一处会出两条一模一样的匹配）。
- `ignoreCase: true` 的时候逐码点 `toLowerCase` 折叠了再比：模式表里的字符和文本里的字符
  都折。**折完码点数会变的那些字符（比如 `İ`）当它没折**，就按原样参与，这样位置才不会错位。
- 模式重样是在**折叠之后**看的：`['Ab', 'aB']` 配 `ignoreCase: true` 也算重样。
- `maxMatches` 给正整数就最多报这么多条，超出的悄悄丢掉并把 `truncated` 置 true；不给就是全报。

### 位置怎么数

- 位置一律按**码点**数，不是 UTF-16 的 code unit：`'a😀b'` 里 `b` 的位置是 2。
- 每条匹配是 `{ pattern, index, length }`：`index` 是**起点**的码点位置，`length` 是模式的码点数；
  `pattern` 是模式表里**原样**的那条（没折叠过）。区分大小写时 `'Ab'` 和 `'ab'` 不互相匹配。
- 换行、代理对、组合字符都按码点算，`\r\n` 是两个码点。

### scan：一把梭

`scan(text)` 和 `scan(patterns, text, options)` 返回 `{ matches, truncated }`：

- **重叠的全都要报**：模式 `'aa'` 扫 `'aaa'` 出来的是起点 0 和 1 两条。
- 排序：先按**结束位置**（`index + length`）升序，结束位置一样时按 `length` **降序**，
  再一样就按模式在 `patterns` 里的先后。同一处先报长的那条，就是这个降序。

### createScanner：一块一块喂

`createScanner(patterns, options)` → `{ push, end, all, state }`：

- `push(chunk)` 追加一块文本，返回**只在这一次 push 里报出来的**匹配（数组，排序同年份的 `scan`）。
  跨块的匹配要等到结尾那一块到了才报，报出来的 `index` 是**从这一路开头算的全局码点位置**。
- 一块的末尾正好是半个代理对时，那半个先压着不喂给自动机，等下一块补齐；
  喂进去的码点数（`fed`）也只算补齐了的那些。
- `state()` 返回 `{ fed, pending, total, truncated, closed }`：
  - `fed` 是已经处理掉的码点数；
  - `pending` 是**还悬着的尾巴长度**：从当前自动机状态顺着失败链往上找，找到第一个**还有出边**的
    状态（根不算），它的深度就是 `pending`，找不到就是 0 —— 也就是「刚喂进去的尾巴里，还有多长
    能被下一块接着拼上」；
  - `total` 是到目前为止报出来的条数；`truncated` 是有没有因为 `maxMatches` 丢过；`closed` 是封没封口。
- `end()` 封口，再 `push` 就报 `ERR_STREAM_CLOSED`；返回值跟 `state()` 一样（`closed: true`），
  重复调 `end()` 还是那份快照。
- `all()` 是把到目前为止报出来的匹配按报出来的顺序拼起来。

## API

```js
import { createMatcher, createScanner, scan } from './lib/matchgrid.js';

scan(['ab', 'b'], 'xabxab');
// -> { matches: [{ pattern: 'ab', index: 1, length: 2 }, ...], truncated: false }

const matcher = createMatcher(['select'], { ignoreCase: true, maxMatches: 10 });
matcher.patterns;        // -> ['select']（拷贝，外面改它不影响已经建好的自动机）
matcher.scan('SELECT');  // -> { matches, truncated }
matcher.scanner();       // -> 跟 createScanner 一样的扫描器

const scanner = createScanner(['abc', 'c']);
scanner.push('ab');      // -> []
scanner.push('c');       // -> [{ pattern: 'abc', index: 0, length: 3 }, { pattern: 'c', index: 2, length: 1 }]
scanner.state();         // -> { fed: 3, pending: 0, total: 2, truncated: false, closed: false }
scanner.all();
scanner.end();
```

出错一律抛 `MatchgridError`（`lib/errors.js`），按 `code` 分流：

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_PATTERNS` | `patterns` 不是数组、是空数组、里面有不是字符串的、有空串、有（折叠后）重样的 |
| `ERR_BAD_ARGS` | `options` 不是对象、`ignoreCase` 不是布尔、`maxMatches` 给了但不是正整数、`scan` / `push` 的文本不是字符串 |
| `ERR_STREAM_CLOSED` | `end()` 之后又 `push` |

## demo 跑出来应该长这样

```
matchgrid demo
  overlaps aa@0+2 aa@1+2
  nested a@0+1 aa@0+2 a@1+1 aa@1+2 a@2+1
  codepoints 😀b@1+2 中@3+1
  ignoreCase Ab@0+2 Ab@3+2
  maxMatches a@0+1 a@1+1 truncated=true
  matcher select@4+6 elect@5+5
  chunk1 []
  chunk2 ["abc@0+3","c@2+1"]
  stream {"fed":3,"pending":0,"total":2,"truncated":false,"closed":false}
  splitPair ["a😀@0+2","😀@1+1"]
  pending 2
  closed {"fed":3,"pending":2,"total":0,"truncated":false,"closed":true}
```
