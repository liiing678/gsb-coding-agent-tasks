# globignore

按 `.gitignore` 那套口径判一条路径该不该忽略：哪些规则锚在根上、`*` 和 `**` 各管多宽、
目录被排掉之后里面的文件还能不能翻案。只用 Node 标准库，没有第三方包，`node >= 20`。

```
globignore/
├── lib/
│   ├── globignore.js   createIgnore 本体            ← 还没实现
│   └── errors.js       IgnoreError 与全部错误码
├── test/               match / walk 两组用例
├── scripts/demo.mjs    手工过一遍的演示脚本
└── package.json        npm test / npm run demo
```

```
npm test        # 14 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 规则怎么读

`createIgnore({ lines, caseSensitive })`：`lines` 是忽略文件的每一行，顺序就是优先级。
逐行这么处理：

- 行尾的 `\r` 去掉；行尾**未转义**的空格和制表符不算（写 `\ ` 才是真的空格）；
  行首的空格算数，不去。
- 去完还是空行、或者以 `#` 开头的，是注释，丢掉。
- 以 `!` 开头（未被转义的）是取反规则，`pattern` 是 `!` 后面那一截；只剩一个 `!` 不合法。
- 以 `/` 结尾（未被转义的）是「只匹配目录」的规则，判的时候把结尾的 `/` 去掉。
- 再去掉可选的前导 `/`（`/dist` 就是锚定在根上的 `dist`）。
- `pattern` 按 `/` 切段，任何一段是空的都不合法（`a//b`）。
- 规则里含 `/`（除了结尾那个）就是**锚定**的：从根开始整条相对路径都要对上；
  不含 `/` 的是**浮动**的，等于在前面补一个 `**/`，哪一层的同名条目都算。

### 通配

- `*` 匹配一段里任意多个字符，**不跨 `/`**；`?` 匹配一段里的一个字符。
- `[abc]`、`[a-z]`、`[!abc]`（`^` 也行）是字符类，没配对的 `]`、空的字符类都不合法。
- `\x` 是转义，`\*` 只匹配字面上的星号。
- `**` 只能自己占一整段，写在段中间（`a**b`）不合法：
  - 夹在中间或写在开头时**允许零层**：`docs/**/tmp` 匹配 `docs/tmp` 也匹配 `docs/v1/tmp`；
    `**/generated` 匹配 `generated` 也匹配 `a/b/generated`。
  - 写在结尾的 `**` **至少要吃掉一层**：`cache/**` 匹配 `cache/one.bin`、`cache/a/b.bin`，
    但不匹配 `cache` 这个目录本身（`abc/**` 只对 abc 里面的东西生效）。

### 谁说了算

- 一条一条往下看，**最后一条命中的规则**说了算：命中的是取反规则就是不忽略，否则就是忽略；
  一条都没命中就是不忽略。
- 只匹配目录的规则，只有在 `isDir` 为真时才可能命中。
- **父目录剪枝**：路径里任何一层祖先目录被判成忽略，这条路径就直接忽略，后面的取反规则救不回来
  （`.gitignore` 的规矩：父目录被排除，就没法再把里面的文件挑出来）。
  目录自己要是被后面的取反规则救回来了，那就不算被剪掉，里面的文件还能各自判各自的。
- 剪枝返回的 `blockedBy` 是**最外面**那一层被排除的祖先。

### 路径的写法

`test` 收的是相对根的 POSIX 路径：不带前导 `/`、不带反斜杠、不带结尾的 `/`（目录用 `isDir` 标），
也不能出现空的、`.` 或 `..` 的路径段。

### 大小写

`caseSensitive` 默认 `true`。给 `false` 的时候，`pattern` 和路径**两边都先转小写**再比
（所以 `*.LOG` 里的 `LOG` 会变成 `log`，字符类里的 `A-Z` 也就成了 `a-z`）——就这一条口径，
别去碰 locale。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_ARGS` | `createIgnore` 的配置不是对象、`lines` 不是字符串数组、`caseSensitive` 不是布尔；`test` 的第二个参数不是对象、`isDir` 不是布尔；`partition` 的入参不是数组、条目不是对象 |
| `ERR_BAD_RULE` | 某一行规则本身不合法（只有 `!`、`a**b`、`a//b`、没配对的 `[`、空的字符类……），`details` 里给 `index` 和 `source` |
| `ERR_BAD_PATH` | 路径不是非空字符串、带前导 `/`、带 `\`、带结尾 `/`、有空的或者 `.` / `..` 段 |

## API

```js
import { createIgnore, DEFAULTS } from './lib/globignore.js';

const ignore = createIgnore({
  lines: ['build/', '*.log', '!keep.log'],
  caseSensitive: true,          // 默认就是 true
});

ignore.test('a.log');                    // -> { ignored: true,  rule: 1, blockedBy: null }
ignore.test('keep.log');                 // -> { ignored: false, rule: 2, blockedBy: null }
ignore.test('build/keep.md');            // -> { ignored: true,  rule: null, blockedBy: 'build' }
ignore.test('build', { isDir: true });   // -> { ignored: true,  rule: 0, blockedBy: null }

ignore.partition([
  { path: 'src/app.js' },
  { path: 'build', isDir: true },
  { path: 'build/out.js' },
]);                                      // -> { kept: [...], ignored: [...] }，各自保持输入顺序

ignore.rules();                          // 解析出来的规则，每条带 index / source / pattern /
                                         // negated / dirOnly / anchored
```

`test` 返回的 `rule` 是**这条路径自己**最后命中的规则下标（按 `lines` 里的原始行号算，
注释和空行也占号），被祖先剪掉时是 `null`、改用 `blockedBy`。

出错一律抛 `IgnoreError`（`lib/errors.js`），按 `code` 分流。

## demo 跑出来应该长这样

`npm run demo` 里的规则和路径都是写死的，输出每一行都能对上：

```
globignore demo
  rules: node_modules/ | build/ | *.log | /dist | docs/**/tmp | !build/keep.md | !important.log
  keep   src/app.js (rule=-)
  IGNORE node_modules/left-pad/index.js (blockedBy=node_modules)
  IGNORE deep/nested/error.log (rule=3)
  keep   important.log (rule=7)
  IGNORE build/keep.md (blockedBy=build)
  IGNORE build/out.js (blockedBy=build)
  IGNORE dist/bundle.js (blockedBy=dist)
  keep   src/dist/bundle.js (rule=-)
  IGNORE docs/v1/tmp/ (rule=5)
  IGNORE docs/tmp/note.md (blockedBy=docs/tmp)
  partition kept=3 ignored=7
```
