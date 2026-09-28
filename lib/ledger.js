// 复式记账：只认分录，记错了只能冲正；封账期间谁也不许动。
// 金额一律是最小单位的整数（分），全程整数运算，不碰浮点。

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];

import { LedgerError } from './errors.js';

const REV_SUFFIX = ':rev';
const DEBIT_NORMAL_TYPES = new Set(['asset', 'expense']);

const fail = (code, message, details = {}) => {
  throw new LedgerError(code, message, details);
};

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const isRealDate = (value) => {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const requireDate = (value, label) => {
  if (!isRealDate(value)) fail('ERR_BAD_ARGS', `${label} 必须是真实存在的 YYYY-MM-DD 日期`, { date: value });
};

const clonePostings = (postings) =>
  postings.map((posting) => ({ account: posting.account, amount: posting.amount }));

export function createLedger(config = {}) {
  if (
    config === null ||
    typeof config !== 'object' ||
    !Array.isArray(config.accounts) ||
    config.accounts.length === 0
  ) {
    fail('ERR_BAD_CONFIG', 'accounts 必须是非空数组');
  }

  const accounts = [];
  const accountsById = new Map();
  for (const account of config.accounts) {
    if (account === null || typeof account !== 'object') {
      fail('ERR_BAD_CONFIG', '每个账户都必须是对象');
    }
    if (!isNonEmptyString(account.id)) {
      fail('ERR_BAD_CONFIG', '账户 id 必须是非空字符串', { account });
    }
    if (!ACCOUNT_TYPES.includes(account.type)) {
      fail('ERR_BAD_CONFIG', `账户类型必须是 ${ACCOUNT_TYPES.join(' / ')} 之一`, {
        id: account.id,
        type: account.type,
      });
    }
    if (!isNonEmptyString(account.currency)) {
      fail('ERR_BAD_CONFIG', '账户 currency 必须是非空字符串', { id: account.id });
    }
    if (accountsById.has(account.id)) {
      fail('ERR_BAD_CONFIG', '账户 id 不能重复', { id: account.id });
    }
    const stored = { id: account.id, type: account.type, currency: account.currency };
    accounts.push(stored);
    accountsById.set(stored.id, stored);
  }

  const entries = [];
  const entryIds = new Set();
  const reversedIds = new Set();
  let lockedThrough = null;
  let reversalCount = 0;

  const assertOpen = (date) => {
    if (lockedThrough !== null && date <= lockedThrough) {
      fail('ERR_PERIOD_LOCKED', `${date} 已经封账（封到 ${lockedThrough}）`, {
        date,
        lockedThrough,
      });
    }
  };

  const storeEntry = (id, date, postings) => {
    const entry = {
      id,
      date,
      postings: clonePostings(postings),
      seq: entries.length,
    };
    entries.push(entry);
    entryIds.add(id);
    return entry;
  };

  const publicEntry = (entry) => ({
    id: entry.id,
    date: entry.date,
    postings: clonePostings(entry.postings),
  });

  // 检查顺序写死：入参结构 → id/date 合法 → 封账 → id 重复 → 逐笔账户金额 → 分币种平衡。
  const post = (entry) => {
    if (entry === null || typeof entry !== 'object') {
      fail('ERR_BAD_ARGS', 'post 的参数必须是一个分录对象');
    }
    requireDate(entry.date, 'date');
    if (!isNonEmptyString(entry.id)) {
      fail('ERR_BAD_ENTRY', '分录 id 必须是非空字符串');
    }
    if (!Array.isArray(entry.postings) || entry.postings.length < 2) {
      fail('ERR_BAD_ENTRY', 'postings 至少要有两笔', { id: entry.id });
    }

    assertOpen(entry.date);

    if (entryIds.has(entry.id)) {
      fail('ERR_DUPLICATE_ENTRY', '分录 id 已经记过', { id: entry.id });
    }

    for (const posting of entry.postings) {
      if (posting === null || typeof posting !== 'object') {
        fail('ERR_BAD_ENTRY', '每笔过账都必须是对象', { id: entry.id });
      }
      if (!accountsById.has(posting.account)) {
        fail('ERR_UNKNOWN_ACCOUNT', '过账账户不在账上', { account: posting.account });
      }
      if (!Number.isSafeInteger(posting.amount) || posting.amount === 0) {
        fail('ERR_BAD_AMOUNT', '金额必须是不为零的安全整数', {
          account: posting.account,
          amount: posting.amount,
        });
      }
    }

    const sums = new Map();
    for (const posting of entry.postings) {
      const currency = accountsById.get(posting.account).currency;
      sums.set(currency, (sums.get(currency) ?? 0) + posting.amount);
    }
    for (const [currency, sum] of sums) {
      if (sum !== 0) {
        fail('ERR_UNBALANCED', `币种 ${currency} 的借贷不平，差额 ${sum}`, { currency, sum });
      }
    }

    return publicEntry(storeEntry(entry.id, entry.date, entry.postings));
  };

  const reverse = (id, options = {}) => {
    const opts = options ?? {};
    if (!isNonEmptyString(id)) {
      fail('ERR_BAD_ARGS', 'reverse 必须给一个分录 id');
    }
    const original = entries.find((entry) => entry.id === id);
    if (!original) {
      fail('ERR_UNKNOWN_ENTRY', '要冲正的分录没记过', { id });
    }
    if (original.id.endsWith(REV_SUFFIX) || reversedIds.has(original.id)) {
      fail('ERR_ALREADY_REVERSED', '这条分录已经冲过，不能再冲', { id });
    }

    const date = opts.date === undefined ? original.date : opts.date;
    requireDate(date, 'date');
    assertOpen(date);

    const reversalPostings = original.postings.map((posting) => ({
      account: posting.account,
      amount: -posting.amount,
    }));
    const reversal = storeEntry(`${original.id}${REV_SUFFIX}`, date, reversalPostings);
    reversedIds.add(original.id);
    reversalCount += 1;
    return publicEntry(reversal);
  };

  const lockPeriod = (options = {}) => {
    const opts = options ?? {};
    requireDate(opts.through, 'through');
    if (lockedThrough !== null && opts.through < lockedThrough) {
      fail('ERR_PERIOD_LOCKED', '封账日期只能往后推，不能往回推', {
        through: opts.through,
        lockedThrough,
      });
    }
    lockedThrough = opts.through;
    return { lockedThrough };
  };

  const entriesUpTo = (asOf) =>
    asOf === undefined ? entries : entries.filter((entry) => entry.date <= asOf);

  const balance = (query = {}) => {
    const q = query ?? {};
    if (typeof q !== 'object' || Array.isArray(q)) {
      fail('ERR_BAD_ARGS', 'balance 的参数必须是对象');
    }
    const account = accountsById.get(q.account);
    if (!account) {
      fail('ERR_UNKNOWN_ACCOUNT', '查询的账户不在账上', { account: q.account });
    }
    if (q.asOf !== undefined) requireDate(q.asOf, 'asOf');

    let net = 0;
    let debit = 0;
    let credit = 0;
    for (const entry of entriesUpTo(q.asOf)) {
      for (const posting of entry.postings) {
        if (posting.account !== account.id) continue;
        net += posting.amount;
        if (posting.amount > 0) debit += posting.amount;
        else credit += -posting.amount;
      }
    }
    return { account: account.id, currency: account.currency, net, debit, credit };
  };

  const trialBalance = (query = {}) => {
    const q = query ?? {};
    if (typeof q !== 'object' || Array.isArray(q)) {
      fail('ERR_BAD_ARGS', 'trialBalance 的参数必须是对象');
    }
    if (q.asOf !== undefined) requireDate(q.asOf, 'asOf');

    const nets = new Map(accounts.map((account) => [account.id, 0]));
    for (const entry of entriesUpTo(q.asOf)) {
      for (const posting of entry.postings) {
        nets.set(posting.account, nets.get(posting.account) + posting.amount);
      }
    }

    const byType = ACCOUNT_TYPES.map((type) => ({ type, net: 0, normal: 0 }));
    for (const account of accounts) {
      const row = byType[ACCOUNT_TYPES.indexOf(account.type)];
      row.net += nets.get(account.id);
    }
    let total = 0;
    for (const row of byType) {
      row.normal = DEBIT_NORMAL_TYPES.has(row.type) ? row.net : -row.net;
      total += row.net;
    }
    return { asOf: q.asOf ?? null, byType, total, balanced: total === 0 };
  };

  const listEntries = (query = {}) => {
    const q = query ?? {};
    if (typeof q !== 'object' || Array.isArray(q)) {
      fail('ERR_BAD_ARGS', 'entries 的参数必须是对象');
    }
    if (q.from !== undefined) requireDate(q.from, 'from');
    if (q.to !== undefined) requireDate(q.to, 'to');

    return entries
      .filter((entry) => {
        if (q.from !== undefined && entry.date < q.from) return false;
        if (q.to !== undefined && entry.date > q.to) return false;
        return true;
      })
      .sort((a, b) => (a.date === b.date ? a.seq - b.seq : a.date < b.date ? -1 : 1))
      .map((entry) => ({
        id: entry.id,
        date: entry.date,
        postings: clonePostings(entry.postings),
        seq: entry.seq,
      }));
  };

  const stats = () => ({
    accounts: accounts.length,
    entries: entries.length,
    postings: entries.reduce((total, entry) => total + entry.postings.length, 0),
    reversals: reversalCount,
    lockedThrough,
  });

  return {
    post,
    reverse,
    lockPeriod,
    balance,
    trialBalance,
    entries: listEntries,
    stats,
  };
}
