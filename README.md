# ledger

一套最小的复式记账：每笔分录借贷两边必须各币种都平，记错了只能冲正不能改，
封账以后的期间谁也别想再动。金额一律是最小单位的整数（分），**不做浮点**。
只用 Node 标准库，没有第三方包，`node >= 20`。

```
ledger/
├── lib/
│   ├── ledger.js      createLedger 本体            ← 还没实现
│   └── errors.js      LedgerError 与全部错误码
├── test/              post / report 两组用例
├── scripts/demo.mjs   手工过一遍的演示脚本
└── package.json       npm test / npm run demo
```

```
npm test        # 12 条用例
npm run demo    # 打印下面那段固定输出
```

## 口径

### 账户

`createLedger({ accounts })`，每个账户是 `{ id, type, currency }`：

- `id` 非空字符串且不能重复；
- `type` 只能是 `asset` / `liability` / `equity` / `income` / `expense`；
- `currency` 是非空字符串（这一版允许账上混着好几个币种）。

### 分录

`post({ id, date, postings })`：

- `id` 非空字符串，记过就不能再记；`date` 是 `YYYY-MM-DD`，必须是真实存在的日子
  （`2026-02-30` 不行，`2024-02-29` 行）。
- `postings` 至少两笔，每笔是 `{ account, amount }`：账户必须在账上，
  金额是**不为零的安全整数**（`Number.isSafeInteger`），正数是借方、负数是贷方。
- **每种币种各自求和都必须是零**（跨币种不能互相抵）：`cash +500 / usd-loan -500`
  不是平的分录，会报 `ERR_UNBALANCED`，`details` 里给 `currency` 和差出来的 `sum`。

`post` 的检查顺序是固定的，一个分录同时踩好几条时按这个顺序报：
**入参结构 → id / date 合法 → 期间有没有封住 → id 是不是重复 → 逐笔看账户和金额 → 按币种算平不平。**
（所以封账期间里递一条重复 id 上来，报的是 `ERR_PERIOD_LOCKED`。）

记账存的是拷贝：`post` 返回的那份、`entries` 捞出来的那份，改它们都不影响账本。

### 冲正

`reverse(id, { date })`：

- 原分录不存在 → `ERR_UNKNOWN_ENTRY`。
- 已经冲过一次、或者拿一条冲正分录（id 以 `:rev` 结尾）来冲 → `ERR_ALREADY_REVERSED`。
- 冲正分录用 `<原 id>:rev` 当 id，`postings` 保持原顺序、金额取反；
  `date` 不给就跟着原分录走，给了就按给的那个（同样要在没封账的期间里）。
- 原分录**不会**被改掉，也不会被删。

### 封账

`lockPeriod({ through })`：记下封账到哪一天，返回 `{ lockedThrough }`。

- 之后 `date <= through` 的分录既不能 `post`、也不能当冲正日期 → `ERR_PERIOD_LOCKED`。
- 日期只能往后推，往回推 → `ERR_PERIOD_LOCKED`；原地不动可以。

### 查询

- `balance({ account, asOf })` → `{ account, currency, net, debit, credit }`：
  净额按「借方为正」累计（`asset` / `expense` 的正数就是余额，另外几类得自己反个号看），
  `debit` / `credit` 是这段时间里借、贷发生额的合计（`credit` 是正数表示的）。
  `asOf` **含当天**（`date <= asOf`）；不传就是全部。
- `trialBalance({ asOf })` → `{ asOf, byType, total, balanced }`：`byType` 按
  `asset / liability / equity / income / expense` 的固定顺序给每一类的
  `net`（借方为正的合计）和 `normal`（这一类业务习惯看的方向：`asset` / `expense` 就是 `net`，
  另外三类是 `-net`）。`total` 是把所有 `net` 加起来，`balanced` 就是 `total === 0`。
- `entries({ from, to } = {})` → 按日期升序（同一天按录入顺序），每条形如
  `{ id, date, postings, seq }`，`seq` 是录入序号（从 0 数）。`from` / `to` 都含当天。
- `stats()` → `{ accounts, entries, postings, reversals, lockedThrough }`，
  `postings` 是所有分录过账笔数的合计，`reversals` 是冲正次数，没封过账就是 `null`。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `ERR_BAD_CONFIG` | `accounts` 不是数组、是空数组，或者某个账户的 id / type / currency 不合法、id 重复 |
| `ERR_BAD_ARGS` | 参数不是对象、日期不是 `YYYY-MM-DD` 或不是真实日子、`reverse` 没给 id |
| `ERR_BAD_ENTRY` | 分录 id 不是非空字符串、`postings` 不是数组或者少于两笔、某笔过账不是对象 |
| `ERR_DUPLICATE_ENTRY` | 这个分录 id 已经记过 |
| `ERR_UNKNOWN_ACCOUNT` | 过账或者查询里提到的账户不在账上 |
| `ERR_UNKNOWN_ENTRY` | 要冲正的分录没记过 |
| `ERR_BAD_AMOUNT` | 金额不是安全整数或者等于零 |
| `ERR_UNBALANCED` | 某个币种借贷不平 |
| `ERR_PERIOD_LOCKED` | 落在已封账期间，或者想把封账日期往回推 |
| `ERR_ALREADY_REVERSED` | 这条分录已经冲过了（包括拿冲正分录去再冲） |

## API

```js
import { createLedger, ACCOUNT_TYPES } from './lib/ledger.js';

const ledger = createLedger({
  accounts: [
    { id: 'cash', type: 'asset', currency: 'CNY' },
    { id: 'sales', type: 'income', currency: 'CNY' },
  ],
});

ledger.post({ id: 'E1', date: '2026-03-01', postings: [
  { account: 'cash', amount: 12_000 },
  { account: 'sales', amount: -12_000 },
]});
ledger.balance({ account: 'cash' });            // -> { account, currency, net, debit, credit }
ledger.balance({ account: 'sales', asOf: '2026-03-01' });
ledger.trialBalance();
ledger.entries({ from: '2026-03-01' });
ledger.reverse('E1', { date: '2026-03-10' });   // -> 冲正那条分录
ledger.lockPeriod({ through: '2026-03-31' });
ledger.stats();
ACCOUNT_TYPES;                                  // ['asset', 'liability', 'equity', 'income', 'expense']
```

出错一律抛 `LedgerError`（`lib/errors.js`），按 `code` 分流。

## demo 跑出来应该长这样

`npm run demo` 里的分录和日期都是写死的，输出每一行都能对上：

```
ledger demo
  cash {"account":"cash","currency":"CNY","net":12000,"debit":12000,"credit":0}
  sales {"account":"sales","currency":"CNY","net":-5000,"debit":0,"credit":5000}
  entries E1@2026-03-01 E2@2026-03-05 E3@2026-03-05
  cash-after-reverse {"account":"cash","currency":"CNY","net":0,"debit":12000,"credit":12000}
  trial ["asset:3900/3900","liability:-900/900","equity:0/0","income:-3000/3000","expense:0/0"]
  balanced true
  locked ERR_PERIOD_LOCKED 2026-02-01 <= 2026-02-28
  unbalanced ERR_UNBALANCED CNY -1
  stats {"accounts":6,"entries":4,"postings":10,"reversals":1,"lockedThrough":"2026-02-28"}
```
