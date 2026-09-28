# mergeline

行级三方合并：给 base / ours / theirs 三份文本，合出一份，冲突的地方按固定格式标出来。
只用 Node 标准库，没有第三方包，`node >= 20`。

```
mergeline/
├── lib/
│   ├── merge.js     mergeThreeWay 本体                       ← 还没实现
│   ├── errors.js    MergeError 与全部错误码
│   └── lines.js     切行 / 拼行 / 比较行
├── test/            basic / conflict / policy 三组用例
├── scripts/demo.mjs 手工过一遍的演示脚本
└── package.json     npm test / npm run demo
```

```
npm test        # 21 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 切行

- 文本按 `\n` 切行。行尾的 `\r` 在比较时当作不存在（CRLF 和 LF 算同一行），
  输出一律用 `\n` 拼。
- 末尾换行会产生最后一个空行，那也算一行：`"a\nb\n"` 是 3 行（`a`、`b`、空串），
  空文本是 0 行。
- 单边上限 20000 行。这不是随便定的：我们那份几千行的配置每次合并都要过一遍，
  一万多行的输入也得能在一两秒里算完，别拿整块的两两比较硬顶。

### 段落怎么切

- base 的每一行要么两边都原样留着（叫公共行），要么被某一边改掉或删掉。
- 两边各自的改动（替换、删除、插入）按它在 base 上的位置聚类：中间一行公共行都没有的
  改动算同一段，隔着至少一行公共行的改动各算一段。
- 插入也算改动：紧挨着某一段的插入并进那一段，两侧都是公共行的插入自己成一段。

### 每一段怎么定

段里看两边在这一段的产出，和 base 这一段比：

| 情况 | 结果 |
|---|---|
| 两边产出一样 | 用这一份，不算冲突 |
| 只有一边跟 base 不一样 | 用不一样的那一边，不算冲突 |
| 两边都跟 base 不一样，互相也不一样 | 冲突 |

### 冲突怎么标

默认 `markers` 风格 + `diff3` 布局：

```
<<<<<<< ours
我们这边的行
||||||| base
base 这一段原来的行
=======
他们那边的行
>>>>>>> theirs
```

`markerLayout: 'merge'` 时不输出 `|||||||` 那一行和 base 段。三个标签可以换
（`oursLabel` / `baseLabel` / `theirsLabel`），换什么就原样写在标记行上。

其它 `conflictStyle`：

- `ours` / `theirs`：冲突段直接取那一边，不留任何标记。
- `union`：冲突段里我们这边的行全留，他们那边没在我们这边出现过的行按顺序接在后面。

`clean` 只说有没有冲突段，跟用哪个风格无关：`union` 把冲突合掉了，`clean` 仍然是
`false`，`stats.conflicts` 也照样是 1。

### 统计

- `stats.segments`：段数（只含插入的段也算）。
- `stats.conflicts`：冲突段数。
- `stats.addedLines` / `stats.removedLines`：最终文本相对 base 的行级差异，替换算一增一删，
  只数行数、不比内容。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_INPUT` | 三份输入里有一个不是字符串，`details.field` 指出是哪一份 |
| `ERR_BAD_OPTION` | `conflictStyle` / `markerLayout` 不认识；`markers` 风格下标签不是非空字符串 |
| `ERR_TOO_MANY_LINES` | 任意一份超过 20000 行，`details` 带 `field` / `lines` / `max` |

## API

```js
import { mergeThreeWay, DEFAULTS, MAX_LINES } from './lib/merge.js';

const out = mergeThreeWay(baseText, oursText, theirsText, {
  conflictStyle: 'markers', // markers | ours | theirs | union
  markerLayout: 'diff3',    // diff3 | merge
  oursLabel: 'ours',
  baseLabel: 'base',
  theirsLabel: 'theirs',
});
```

`options` 不给就用 `DEFAULTS`。返回：

```js
{
  text: '合出来的文本',
  clean: false,       // 没有冲突段才是 true
  conflicts: [
    {
      index: 1,       // 冲突序号，从 1 连着编
      outputLine: 2,  // 标记行在 text 里的行号（1 起）；
                      // 非 markers 风格时是这一段第一行的行号
      oursCount: 1,   // 这一段的三个版本各几行
      baseCount: 1,
      theirsCount: 1,
    },
  ],
  stats: { segments: 1, conflicts: 1, addedLines: 6, removedLines: 0 },
}
```

出错一律抛 `MergeError`（`lib/errors.js`），调用方按 `code` 分流。
`lib/lines.js` 里的 `splitLines` / `joinLines` / `sameLines` 已经写好，切行口径以它为准。

## demo 跑出来应该长这样

`npm run demo` 里的输入都是写死的，输出每一行都能对上：

```
mergeline demo
[1] 两边改了不同的行，干净合进来
    text
      | server
      | port=9090
      | log level=info
      | done (shutdown)
    clean=true segments=2 conflicts=0 added=2 removed=2
[2] 同一行两边各改各的，按 diff3 标出来
    text
      | server
      | <<<<<<< ours
      | port=9090
      | ||||||| base
      | port=8080
      | =======
      | port=7070
      | >>>>>>> theirs
      | done
    clean=false segments=1 conflicts=1 added=6 removed=0
    conflict #1 在第 2 行开标记
[3] 一边删一边改，被删的那行留在 base 段里
    text
      | x
      | <<<<<<< ours
      | ||||||| base
      | y
      | =======
      | y!
      | >>>>>>> theirs
      | z
    clean=false segments=1 conflicts=1 added=5 removed=0
[4] 换成 union，冲突段的两个版本都留着
    text
      | a
      | X
      | XX
      | y
    clean=false segments=1 conflicts=1 added=2 removed=1
[5] 一万两千行里隔得很远的两处改动
    lines=12000
    clean=true segments=2 conflicts=0 added=2 removed=2
```
