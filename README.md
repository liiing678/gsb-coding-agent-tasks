# extmerge

内存放不下的排序：攒够一批就排好写成一个溢出文件，最后按固定的路数多路归并回来。
键一样的时候要保持推进来的先后次序，收尾以后一个临时文件都不许剩。
只用 Node 标准库（`node:fs` / `node:path`），没有第三方包，`node >= 20`。

```
extmerge/
├── lib/
│   ├── extmerge.js    createSorter 本体             ← 还没实现
│   └── errors.js      MergeError 与全部错误码
├── test/              sort / bash 两组用例
├── scripts/demo.mjs   手工过一遍的演示脚本
└── package.json       npm test / npm run demo
```

```
npm test        # 11 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 建一个排序器

`createSorter({ compare, maxInMemory, fanIn, spillDir })`：

- `compare(left, right)`：负数 / 0 / 正数那套，跟 `Array.prototype.sort` 一样。
- `maxInMemory` 默认 `16`：内存里最多同时攒这么多条。
- `fanIn` 默认 `4`：归并的时候一次最多同时开这么多路。
- `spillDir`：一个**已经存在**的目录，溢出文件就写在这儿（不存在或者不是目录直接报错，这一版不帮你建）。
- 这个目录一次只给一个排序器用（文件名是从 `0001` 开始数的）。

### push：攒够了就落盘

`push(item)` 把一条记录推进缓冲区：

- 每条记录带一个**到达序号**，第一条是 0，往后依次加一；这个序号在归并和落盘时都要跟着走。
- 缓冲区里条数到 `maxInMemory` 就**整批排好序**写成一个溢出文件，然后清空。
- 溢出文件名是 `run-0001.jsonl`、`run-0002.jsonl`……四位、从 1 开始、一次会话里连续递增
  （归并阶段产出的中间文件接着这个号继续往下排）。
- 文件内容：一行一条 JSON 对象，`{"seq":<到达序号>,"item":<条目>}`，UTF-8，**每一行都以 `\n` 结尾**
  （最后一行也是）。
- 排序时 `compare` 相等就比到达序号，所以**键一样的记录保持推进来的先后次序**（稳定）。

### finish：归并收尾

`finish()` 返回排好序的条目数组（新数组），并且把这次会话写出去的溢出文件**全部删掉**。

1. 内存里如果还剩着记录：磁盘上已经有 run，就把这批也排好写成一个 run；
   一条 run 都没有（从来没落过盘），那就直接在内存里排好返回，不落盘。
2. 盘上的 run 按 `fanIn` 分批归并：同一轮里按文件编号顺序分组，一组最多 `fanIn` 个，
   一组归并完写成下一个编号的 run，直到整批只剩 `fanIn` 个以内；
   最后一轮（run 数已经不超过 `fanIn`）直接合在内存里出结果，不再落盘。
   这样的轮数记在 `passes` 里（如果盘上本来就只有 1 个 run，`passes` 是 0）。
3. 归并阶段为了简单是**整份读进来**的（这一版不做流式读）；有界的只有 `push` 的缓冲区，
   所以 `peakBuffered` 永远不会超过 `maxInMemory`。

`finish` 之后再 `push` 或者再 `finish` → `ERR_STATE`。

### 统计

`stats()` → `{ pushed, spilled, spilledRuns, peakBuffered, passes }`：

- `pushed`：`push` 进来过多少条；
- `spilled`：写进溢出文件的记录累计有多少条（归并阶段写出去的也算，所以会比 `pushed` 大）；
- `spilledRuns`：一共写出过几个 run 文件（含归并阶段的中间文件）；
- `peakBuffered`：缓冲区里同时最多有过多少条；
- `passes`：归并轮数。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_CONFIG` | 配置不是对象、`compare` 不是函数、`maxInMemory` 不是正整数、`fanIn` 不是不小于 2 的整数、`spillDir` 不是已经存在的目录 |
| `ERR_BAD_VALUE` | `push` 的条目 JSON 序列化不出来（`undefined`、函数、`BigInt`……） |
| `ERR_STATE` | `finish` 之后再 `push` 或者再 `finish` |
| `ERR_IO` | 溢出文件读写或者删除失败 |

## API

```js
import { createSorter, DEFAULTS } from './lib/extmerge.js';

const sorter = createSorter({
  compare: (left, right) => left.key - right.key,
  maxInMemory: 8,
  fanIn: 3,
  spillDir: '/tmp/whatever',
});

sorter.push({ key: 5 });
sorter.finish();     // -> [{ key: 1 }, ...]，排好序，并且把这次写的溢出文件删干净
sorter.stats();      // -> { pushed, spilled, spilledRuns, peakBuffered, passes }
DEFAULTS;            // -> { maxInMemory: 16, fanIn: 4 }
```

出错一律抛 `MergeError`（`lib/errors.js`），按 `code` 分流。

## demo 跑出来应该长这样

`npm run demo` 里的数据都是写死的，输出每一行都能对上：

```
extmerge demo
  defaults maxInMemory=16 fanIn=4
  runs on disk run-0001.jsonl run-0002.jsonl run-0003.jsonl
  head of run-0001 {"seq":3,"item":{"key":1,"tag":"#1"}}
  sorted 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29
  marks #0 #1 #2
  stats {"pushed":30,"spilled":60,"spilledRuns":6,"peakBuffered":8,"passes":2}
  left on disk 0
```
