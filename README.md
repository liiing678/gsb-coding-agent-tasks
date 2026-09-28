# exprvm

把一小段表达式源码编成指令，再用一台栈式虚拟机跑出结果。只支持下面《口径》里那点语法，
只用 Node 标准库，`node >= 20`。

```
exprvm/
├── lib/
│   ├── exprvm.js    compile 与指令生成 / 执行            ← 还没实现
│   └── errors.js    ExprError 与错误码
├── test/            compile / edge 两组用例
├── scripts/demo.mjs 手工过一遍的演示脚本
└── package.json     npm test / npm run demo
```

```
npm test        # 11 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 支持的语法

| 写法 | 意思 |
|---|---|
| `1` `1.5` `.5` `1e3` `1e-3` `0x1f` | 数字（`1.` 这种小数点后面没数字的是错的） |
| `"abc"` `'abc'` | 字符串；转义只认 `\n` `\t` `\r` `\\` `\"` `\'`，别的转义是错的 |
| `true` `false` `null` | 字面量，是关键字，不能当变量名 |
| `a` `a_b1` | 名字：`[A-Za-z_][A-Za-z0-9_]*`，**大小写敏感**，从 `run(env)` 的环境里取 |
| `(expr)` | 括号 |
| `-x` `!x` | 一元，可以叠加（`- -1`、`!!x` 都合法） |
| `+ - * / %` | 算术 |
| `< <= > >=` | 比较 |
| `== !=` | 判等 |
| `&& \|\|` | 逻辑，短路 |
| `c ? a : b` | 三元，**右结合**（`a ? b : c ? d : e` 就是 `a ? b : (c ? d : e)`） |

优先级从低到高：`?:` < `\|\|` < `&&` < `== !=` < `< <= > >=` < `+ -` < `* / %` < 一元 < 括号。
同一层都左结合。表达式后面多东西（`1 2`）、少东西（`1 +`）、括号不闭合、引号不闭合、
不认识的字符（`@`、单个 `=`）、不认识的转义，全是 `ERR_BAD_SYNTAX`。

### 类型与运算规则

值只有四种：数字、字符串、布尔、`null`。环境里给的必须是这四种之一。

- 算术 `- * / %` 要两个数字；`+` 两边都是数字就做加法，只要有一边是字符串就按文本拼接。
- 比较 `< <= > >=` 要两边**同类型**，数字比数字、字符串按码元比字符串，混着来是 `ERR_TYPE`。
- 判等 `== !=` 要两边同类型；同类型就按值比（`null == null` 是 `true`、`null != null` 是 `false`）。
  两边不同类型是 `ERR_TYPE`，不是 `false`。
- 文本化：`null` → 空串、`true` / `false` → `"true"` / `"false"`、数字用 `String(v)`、字符串原样。
- 除零：`/` 和 `%` 的除数是 `0`（`-0` 也算）就抛 `ERR_DIVIDE_BY_ZERO`；`%` 的符号跟被除数走
  （`-7 % 3` 是 `-1`）。
- 一元 `-` 要数字，`!` 什么都收、出布尔。

### 真假值与短路

假值只有这五个：`false`、`0`、`-0`、`""`、`null`，别的都算真。

- `a && b`：`a` 是假就整个返回 `a`（`b` 不跑），否则返回 `b` 的值。
- `a \|\| b`：`a` 是真就整个返回 `a`（`b` 不跑），否则返回 `b` 的值。
- `c ? a : b`：只算走到的那个分支。

所以 `false && (1 / 0)` 是 `false`、`true \|\| nope` 是 `true`，都不许因为没走到的分支报错；
反过来 `true && nope`、`false \|\| (1 / 0)` 该报什么报什么。

### 优化器

`compile(source, { optimize = true })`。开的时候只做两件事：

1. 常量折叠：两个常量参加的运算，**算得出来才折**（`1 + 2 * 3` 折成 `7`）；
2. 常量条件分支消除：`&&` / `\|\|` 左边是常量且已经短路时整段换成那个常量；三元条件是常量时只留
   走到的分支（`true ? 1 : nope` 里 `nope` 整段消失，跑到也不会变成 `ERR_UNKNOWN_NAME`）。

会抛错的组合**不许折**：`1 / 0`、`1 - "a"` 必须原样保留，等到真跑起来才抛。
开了和关了，同一份源码配同一个环境，跑出来的值或者错误码必须一模一样。

### 出错的地方

| 错误码 | 什么时候抛 | `details` |
|---|---|---|
| `ERR_BAD_ARGUMENT` | `source` 不是字符串、`options` 不是普通对象、`optimize` 不是布尔、`run` 的环境不是普通对象 | `{}` |
| `ERR_BAD_SYNTAX` | 语法错 | `{ index, line, column }`，`index` 从 0 数、行列从 1 数 |
| `ERR_UNKNOWN_NAME` | 环境里没有这个名字 | `{ name }` |
| `ERR_TYPE` | 上面那些类型不对的运算 / 环境里某名字的值不是那四种之一 | `{ name }`（取值时才带） |
| `ERR_DIVIDE_BY_ZERO` | `/` 或 `%` 的除数是 0 | `{}` |

## 指令集

`assembly` 是每条指令一行；跳转目标是**绝对指令下标**；`CONST` 的值按 `JSON.stringify` 写。

| 指令 | 干什么 |
|---|---|
| `CONST v` | 压常量 |
| `LOAD name` | 从环境取值压栈（没有 → `ERR_UNKNOWN_NAME`，类型不对 → `ERR_TYPE`） |
| `UNARY neg` / `UNARY not` | 弹一个，压一元结果 |
| `BIN op` | 弹两个，先弹出来的当右操作数；`op` 是 `add sub mul div mod lt le gt ge eq ne` |
| `DUP` / `POP` | 复制栈顶 / 丢栈顶 |
| `JUMP n` / `JUMPF n` / `JUMPT n` | 无条件跳 / 弹一个、假才跳 / 弹一个、真才跳 |
| `RET` | 弹栈顶当结果返回 |

求值顺序是左操作数先入栈、右操作数后入栈，所以 `1 + 2 * 3` 没折叠时是
`CONST 1` `CONST 2` `CONST 3` `BIN mul` `BIN add` `RET`。同一份源码编译两次，`assembly` 得一样。
`compile` 出来的对象要是无状态的，同一个对象反复 `run` 互不影响。

## API

| 入口 | 说明 |
|---|---|
| `compile(source, { optimize = true })` | 返回 `{ source, assembly, run(env) }` |
| `run(env = {})` | 值或抛 `ExprError`；`env` 要是普通对象，值只收数字 / 字符串 / 布尔 / `null` |

## demo 跑出来应该长这样

```
exprvm demo
  arithmetic 7
  assembly ["CONST 7","RET"]
  unoptimized ["CONST 1","CONST 2","CONST 3","BIN mul","BIN add","RET"]
  strings "n=42"
  compare true
  shortCircuit false
  env 7
  ternary "off"
  typeError ERR_TYPE
  divideByZero ERR_DIVIDE_BY_ZERO
  syntaxError {"code":"ERR_BAD_SYNTAX","index":4,"line":2,"column":1}
```
