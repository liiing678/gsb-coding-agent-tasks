# solvemod

依赖版本求解：给一个内存包源和 root 的依赖，挑出每个包的一个版本，让所有约束同时成立；
挑不出来就说清是谁卡住了。只用 Node 标准库，没有第三方包，`node >= 20`。

```
solvemod/
├── lib/
│   ├── resolve.js    resolveDeps 本体                      ← 还没实现
│   ├── semver.js     版本号比较、范围解析、satisfies
│   ├── registry.js   内存包源（包名 -> 版本 -> 依赖）
│   └── errors.js     SolveError 与全部错误码
├── test/             solve / conflict / pins 三组用例
├── scripts/demo.mjs  手工过一遍的演示脚本
└── package.json      npm test / npm run demo
```

```
npm test        # 21 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 求解的是什么

- `root.deps` 是要满足的全部起点约束；root 自己不进结果。
- 每个被约束到的包选一个版本，让所有约束都成立。约束来自 root，也来自被选中版本自己的
  `deps`（所以依赖的依赖也要一起解）。
- `pins` 里的包被钉死在那个版本上，别的版本一律不考虑。
- 版本号只认 `x.y.z` 三段数字，范围语法以 `lib/semver.js` 为准：`^` `~` `>=` `<=` `>`
  `<` `=`、空格当且仅当、`||` 当或、`1.2.x` / `1.x` / `*` 这些通配。不允许预发布版本。

### 怎么选

- 待定的包按名字排，每次处理名字最小的那个；先挑**满足当前全部约束的最高版本**。
- 选完之后，把这个版本自己的 `deps` 加进约束，继续往下解。
- 如果选完发现某个已经定下来的包不再满足新加进来的约束（或者后面的包没版本可选了），
  就退回去换这个包的下一个低版本；本层换完还不行再往上一层退。
- 同一个请求方（`包@版本`）对同一个包提的同一条范围只算一条约束；重复提不算新约束。
- 互相依赖成环是允许的，同一次求解里一个包只会有一个版本。

### 结果长什么样

- `packages`：包名 -> 版本，键按名字排好序。
- `order`：安装顺序。依赖排在依赖它的人前面；同一层按名字升序。**成环的时候没有先后，
  环里剩下的包按名字升序接在后面。**
- `stats.considered`：试过的 `包 + 版本` 对数（含试完发现不行的）。
- `stats.backtracks`：退回去换版本的次数。
- `stats.constraints`：去重之后记下来的约束条数。

### 解不出来的时候

`ERR_UNSATISFIED` 的 `details`：

- `pkg`：最先卡住的那个包；
- `chain`：这个包当时身上的全部约束，`{ from, range }`，`from` 是 `包@版本`
  （root 提的就是 `rootName@rootVersion`），按加进来的顺序、从 root 往里；
- `versions`：满足这些约束的候选版本（从高到低），一个都没有就是 `[]`。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_INPUT` | 入参形状不对（root / root.deps / pins / maxBacktracks） |
| `ERR_BAD_RANGE` | 某个范围解析不了，`details` 带 `pkg` / `range` / `from` |
| `ERR_UNKNOWN_PACKAGE` | 约束里出现包源里没有的包，`details` 带 `pkg` / `from` |
| `ERR_NO_SUCH_VERSION` | 钉住的版本在包源里没有，`details` 带 `pkg` / `pin` / `versions` |
| `ERR_UNSATISFIED` | 怎么回溯都解不出来，见上一节 |
| `ERR_PIN_CONFLICT` | 钉住的版本不满足某条约束，`details` 带 `pkg` / `pin` / `range` / `from` |
| `ERR_TOO_MANY_BACKTRACKS` | 回退次数超过 `maxBacktracks`，`details` 带 `maxBacktracks` / `backtracks` |

## API

```js
import { resolveDeps, DEFAULTS } from './lib/resolve.js';
import { createRegistry } from './lib/registry.js';

const registry = createRegistry({
  packages: {
    applib: { versions: { '1.0.0': { deps: { 'core-lib': '^1.0.0' } } } },
    'core-lib': { versions: { '1.4.0': { deps: {} } } },
  },
});

const out = resolveDeps({
  registry,
  root: { name: 'app', version: '0.0.0', deps: { applib: '^1.0.0' } },
  pins: { 'core-lib': '1.4.0' }, // 可选
  maxBacktracks: 200,            // 可选，默认 DEFAULTS.maxBacktracks
});
```

返回：

```js
{
  packages: { applib: '1.0.0', 'core-lib': '1.4.0' },
  order: ['core-lib', 'applib'],
  stats: { considered: 2, backtracks: 0, constraints: 2 },
}
```

出错一律抛 `SolveError`（`lib/errors.js`），调用方按 `code` 分流。
`lib/semver.js`（`parseRange` / `satisfies` / `compareVersions` / `sortVersionsDesc`）和
`lib/registry.js` 都已经写好，范围语义以它们为准，别改也别绕开。

## demo 跑出来应该长这样

`npm run demo` 里的包源都是写死的，输出每一行都能对上：

```
solvemod demo
[1] 直接依赖 + 依赖的依赖
    packages applib@1.0.0 core-lib@1.4.0
    order core-lib,applib
    stats considered=2 backtracks=0 constraints=2
[2] 两个约束一起看，高的那个不满足就往下退
    packages alpha@1.0.0 beta@1.0.0 cache@1.1.0
    order cache,alpha,beta
    stats considered=3 backtracks=0 constraints=4
[3] 最新版是条死路，退一档再解
    packages alpha@1.0.0 core@1.0.0
    order core,alpha
    stats considered=3 backtracks=1 constraints=2
[4] 钉住版本：cache 就停在 1.0.0，不去挑 1.1.0
    packages alpha@1.0.0 beta@1.0.0 cache@1.0.0
    order cache,alpha,beta
    stats considered=3 backtracks=0 constraints=4
[5] 怎么都解不出来，说清是谁卡住谁提的要求
    ERR_UNSATISFIED cache 卡住：alpha@1.0.0 ^1.0.0 / beta@2.0.0 ^3.0.0
```
