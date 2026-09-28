# pagetable

给编辑器用的文本缓冲：内容按 **piece table** 存（原文加一段只增不减的 add 区，中间插删只动
指向这两段的块，不整块复制字符串），另外带 0 基的行列定位、撤销重做和事务。只用 Node 标准库，
`node >= 20`。

```
pagetable/
├── lib/
│   ├── pagetable.js   createBuffer 与全部编辑/定位能力   ← 还没实现
│   └── errors.js      PagetableError 与全部错误码
├── test/              buffer / lines 两组用例
├── scripts/demo.mjs   手工过一遍的演示脚本
└── package.json       npm test / npm run demo
```

```
npm test        # 12 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 内容怎么存

- 缓冲区两份底稿：`original`（`createBuffer` 传进来的那份，之后一个字都不改）和 `add`
  （**只增不减**：插入/替换进来的内容一律追加到它尾巴上，撤销、回滚都不缩回去）。
- 当前内容是若干块拼起来，每块 `{ source, start, length }`：`source` 是 `original` 或 `add`。
  `text()` 就是按块顺序把两段底稿切下来拼起来。
- 长度一律按 **UTF-16 code unit** 算（`'a'.length` 那套，不用字符数/码点数）。
- 中间插入 = 把落点那块切成「前半」+ 新块 + 「后半」；删除 = 把每块跟删除区间重叠的部分削掉。
  长度 0 的块不入表；**相邻两块如果同源而且位置首尾相接（`前.start + 前.length === 后.start`），
  必须并成一块**。`stats().pieces` 数的是并完之后的块数，所以插入/删除之后它是确定的。
- `stats().addLength` 是 add 区当前大小，只增不减。

### 行列定位

- 行按 `\n` 切，**行号 0 基**；空内容是 1 行，结尾的 `\n` 后面算一个空行
  （`'one\ntwo\n'` 有 3 行，第 2 行是空串）。
- `lineAt(line)` 不含行尾的 `\n`。
- `positionAt(offset)` → `{ line, column }`：`line` 是 offset 之前出现过的 `\n` 个数，
  `column` 是从这一行行首数过来的 code unit 数。正好落在 `\n` 上就是这一行的行尾。
- `offsetAt(line, column)` 是它的逆运算；`column` 超过这一行长度（不含 `\n`）算越界。

### 撤销、重做、事务

- 每次真的改动了内容的编辑（插入空串、删 0 个、替换成空且删 0 个**不算**）压一步撤销记录，
  一次 `replace` 只算一步；新的编辑会把重做栈清掉。
- `undo()` / `redo()` 返回布尔：栈空返回 `false`，不抛错。
- `transaction(fn)` 把 `fn` 里所有编辑合成一步：整个过程只压一条撤销记录（`fn` 里啥都没改就不压）；
  `fn` 里**抛了错就把这次事务里改的整个回滚**（撤销栈也不留痕迹），再把原错误抛出去。
  事务不能嵌套，嵌套直接报 `ERR_NESTED_TRANSACTION`。

## API

```js
import { createBuffer } from './lib/pagetable.js';

const buf = createBuffer('hello world');
buf.length();               // 11
buf.slice(6, 5);            // 'world'
buf.insert(5, ',');
buf.text();                 // 'hello, world'
buf.stats().pieces;         // 3（原文被切开 + 新块）
buf.delete(0, 1);           // 删掉 'h'
buf.replace(0, 1, 'H');     // 一步替换
buf.lineCount();            // 1
buf.lineAt(0);              // 'Hello, world'
buf.positionAt(6);          // { line: 0, column: 6 }
buf.offsetAt(0, 6);         // 6
buf.undo();                 // true
buf.redo();                 // true
buf.transaction(() => { buf.insert(0, '> '); buf.delete(0, 1); });
buf.stats();                // { length, lines, pieces, addLength, undoDepth, redoDepth }
```

出错一律抛 `PagetableError`（`lib/errors.js`），按 `code` 分流：

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_ARGUMENT` | `createBuffer` 的内容不是字符串、插入/替换的内容不是字符串、offset / count / line / column 不是非负整数、`transaction` 收的不是函数 |
| `ERR_OUT_OF_RANGE` | offset 超过长度、offset + count 超过长度、行号越界、列号超过该行长度 |
| `ERR_NESTED_TRANSACTION` | 事务里又开事务 |

## demo 跑出来应该长这样

```
pagetable demo
  initial {"text":"one\ntwo\n","length":8,"lines":3}
  afterInsert {"text":"one!\ntwo\n","pieces":3}
  addLength 2
  afterDeletePieces 3
  slice "\ntw"
  positionAt 4 {"line":0,"column":4}
  offsetAt 1,2 7
  lineAt 1 "two"
  undo true
  afterUndo {"text":"#one!\ntwo\n","pieces":4,"addLength":2}
  redo true
  afterRedo "one!\ntwo\n"
  transaction {"text":"bcd","undoDepth":1}
  txnUndo {"text":"abc","undoDepth":0}
  rollback boom
  afterRollback abc
  nested ERR_NESTED_TRANSACTION
```
