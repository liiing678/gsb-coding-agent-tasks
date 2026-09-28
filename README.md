# wrapfold

折行：按码点算宽度、按字素簇断行、把收尾标点留在上一行、把开括号推到下一行，
再顺手做一个按宽度截断的小工具。只用 Node 标准库（字素用 `Intl.Segmenter`），`node >= 20`。

```
wrapfold/
├── lib/
│   ├── wrapfold.js   displayWidth / wrap / clip   ← 还没实现
│   └── errors.js     WrapfoldError 与全部错误码
├── test/             width / wrap 两组用例
├── scripts/demo.mjs  手工过一遍的演示脚本
└── package.json      npm test / npm run demo
```

```
npm test        # 12 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 宽度

`displayWidth(text)` 把每个**码点**的宽度加起来：

- **0 宽**：U+0300–U+036F、U+1AB0–U+1AFF、U+20D0–U+20FF、U+200B–U+200F、U+FE00–U+FE0F、U+FEFF；
- **2 宽**：U+1100–U+115F、U+2E80–U+303E、U+3041–U+33FF、U+3400–U+4DBF、U+4E00–U+9FFF、
  U+A000–U+A4CF、U+AC00–U+D7A3、U+F900–U+FAFF、U+FE30–U+FE6F、U+FF00–U+FF60、U+FFE0–U+FFE6、
  U+1F300–U+1F64F、U+1F900–U+1F9FF、U+20000–U+3FFFD；
- 别的都是 **1 宽**（制表符也算 1，不管它落在哪一列）。

### 折行

`wrap(text, { width = 20, indent = '', hangingIndent, breakLongWords = false } = {})`
返回 `{ lines, overflow }`，`lines` 每条是 `{ text, width }`（`width` 是 `displayWidth(text)`）。

- `width` 是**含缩进**的总宽度上限，得是正整数；`indent` 是首行缩进，`hangingIndent` 是续行缩进，
  不给就跟着 `indent`。两种情况下的缩进宽度都必须**小于** `width`，不然没地方放内容。
- 文本先按换行切成段：`\r\n` 和单独的 `\r` 都当换行（`\r` 本身不算宽度）。每段单独折，
  空段也要出一行（就是只有缩进的那一行）。
- 一行在**宽度装得下的前提下**尽量往里塞，断点只认这三种，从右往左挑最近的：
  1. 空格之后 —— 这个空格被吃掉，两边的行里都不留它；
  2. `-` 之后 —— 连字符留在**上一行**行尾；
  3. 两个都是 2 宽的字符之间 —— 也就是汉字、全角字符之间可以断。
- **禁则**：先看断点左边那个字符，如果是行尾禁则字符（`([{<（「『【《〈`）就把断点往左收一位
  （但它至少给这一行留一个字符，收不动就按原来的断点）；再看断点右边那个字符，如果是行首禁则
  字符（`,.;:!?)]}>%，。、；：！？）」』】》〉％`）就把断点往右推，把这些字符带上，
  直到下一个字符不再是禁则字符。禁则修正让这一行超宽是可以的，`overflow` 里会记着。
- 一整块**哪里都断不了**（比如一个很长的英文单词）时：
  - `breakLongWords` 不给或者 false → 这一块自己占一行（超宽就超宽）；
  - `true` → 按**字素簇**硬断，能塞几个塞几个，组合记号不会跟它的基字符分到两行。
- 行尾的空格一律吃掉（不进 `text`，也不算宽度）。
- `overflow` 是整份结果里**超宽行的条数**（`width > 你给的 width`）。

### 截断

`clip(text, width, ellipsis = '…')` 返回 `{ text, width, clipped }`：

- `displayWidth(text) <= width` 就原样返回，`clipped: false`；
- 否则按**字素簇**从右往左去掉，直到 `displayWidth(剩下的) + displayWidth(ellipsis) <= width`，
  再接上省略号，`clipped: true`（省略号自己的宽度也算进去）；
- 连省略号都放不下（`width` 比省略号还窄）就返回 `{ text: '', width: 0, clipped: true }`。

## API

```js
import { displayWidth, wrap, clip, DEFAULTS } from './lib/wrapfold.js';

displayWidth('中文 abc');     // -> 8
displayWidth('a\u0301');      // -> 1（组合记号 0 宽）

wrap('把这句话折成宽度 12 的几行', { width: 12 });
// -> { lines: [{ text, width }, ...], overflow: 0 }

wrap(text, { width: 10, indent: '  ', hangingIndent: '    ', breakLongWords: true });

clip('这是一句很长的话', 7);   // -> { text: '这是一句…', width: 7, clipped: true }
DEFAULTS;                     // -> { width: 20, breakLongWords: false }
```

出错一律抛 `WrapfoldError`（`lib/errors.js`），按 `code` 分流：

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_ARGS` | `text` 不是字符串、`options` 不是对象、`width` 不是正整数、`indent` / `hangingIndent` 不是字符串、`breakLongWords` 不是布尔、某个缩进的宽度大于等于 `width`、`clip` 的 `width` 不是正整数或 `ellipsis` 不是字符串 |

## demo 跑出来应该长这样

```
wrapfold demo
  width 中文 abc=8 a+组合=1
  english overflow=0
    "the quick" 9
    "brown fox" 9
    "jumps" 5
  cjk overflow=0
    "折行的时" 8
    "候汉字之" 8
    "间可以断" 8
    "开" 2
  forbidden overflow=0
    "abcd ，" 7
    "efg" 3
  indent overflow=0
    ">>the quick" 11
    ">>>>brown" 9
    ">>>>fox" 7
  long overflow=1
    "supercalifragilistic" 20
  hard overflow=0
    "superc" 6
    "alifra" 6
    "gilist" 6
    "ic" 2
  clip {"text":"这是一…","width":7,"clipped":true}
```
