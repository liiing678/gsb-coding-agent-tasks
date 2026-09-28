// 复式记账：只认分录，记错只能冲正；封账期间不可动；金额一律整数分。

import { LedgerError } from './errors.js';

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code, message, details = {}) {
  throw new LedgerError(code, message, details);
}

function isValidDate(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function createLedger(config = {}) {
  if (!isPlainObject(config) || !Array.isArray(config.accounts) || config.accounts.length === 0) {
    fail('ERR_BAD_CONFIG', 'accounts 必须是非空数组');
  }

  const accounts = new Map();
  for (const account of config.accounts) {
    if (
      !isPlainObject(account) ||
      !isNonEmptyString(account.id) ||
      !ACCOUNT_TYPES.includes(account.type) ||
      !isNonEmptyString(account.currency)
    ) {
      fail('ERR_BAD_CONFIG', '账户的 id / type / currency 不合法');
    }
    if (accounts.has(account.id)) {
      fail('ERR_BAD_CONFIG', `账户 id 重复：${account.id}`, { id: account.id });
    }
    accounts.set(account.id, {
      id: account.id,
      type: account.type,
      currency: account.currency,
    });
  }

  const entries = [];
  const byId = new Map();
  const reversedIds = new Set();
  let lockedThrough = null;

  const entryView = (entry) => ({
    id: entry.id,
    date: entry.date,
    postings: entry.postings.map((posting) => ({
      account: posting.account,
      amount: posting.amount,
    })),
  });

  const admit = (entry) => {
    const stored = {
      id: entry.id,
      date: entry.date,
      seq: entries.length,
      postings: entry.postings.map((posting) => ({
        account: posting.account,
        amount: posting.amount,
      })),
    };
    entries.push(stored);
    byId.set(stored.id, stored);
    return entryView(stored);
  };

  const ensureUnlocked = (date) => {
    if (lockedThrough !== null && date <= lockedThrough) {
      fail(
        'ERR_PERIOD_LOCKED',
        `${date} 已在封账期间内（封到 ${lockedThrough}）`,
        { date, lockedThrough },
      );
    }
  };

  function post(entry) {
    if (!isPlainObject(entry)) {
      fail('ERR_BAD_ARGS', 'post 的入参必须是对象');
    }
    const { id, date, postings } = entry;

    if (!isNonEmptyString(id)) {
      fail('ERR_BAD_ENTRY', '分录 id 必须是非空字符串');
    }
    if (!isValidDate(date)) {
      fail('ERR_BAD_ARGS', `日期不合法：${String(date)}`);
    }
    ensureUnlocked(date);
    if (byId.has(id)) {
      fail('ERR_DUPLICATE_ENTRY', `分录 id 已存在：${id}`, { id });
    }

    if (!Array.isArray(postings) || postings.length < 2) {
      fail('ERR_BAD_ENTRY', 'postings 至少要有两笔');
    }
    for (const posting of postings) {
      if (!isPlainObject(posting)) {
        fail('ERR_BAD_ENTRY', '每笔过账必须是对象');
      }
      if (!accounts.has(posting.account)) {
        fail('ERR_UNKNOWN_ACCOUNT', `账户不存在：${String(posting.account)}`, {
          account: posting.account,
        });
      }
      if (!Number.isSafeInteger(posting.amount) || posting.amount === 0) {
        fail('ERR_BAD_AMOUNT', '金额必须是不为零的安全整数', {
          account: posting.account,
          amount: posting.amount,
        });
      }
    }

    const sums = new Map();
    for (const posting of postings) {
      const currency = accounts.get(posting.account).currency;
      sums.set(currency, (sums.get(currency) ?? 0) + posting.amount);
    }
    for (const [currency, sum] of sums) {
      if (sum !== 0) {
        fail('ERR_UNBALANCED', `币种 ${currency} 借贷不平，差额 ${sum}`, {
          currency,
          sum,
        });
      }
    }

    return admit({ id, date, postings });
  }

  function reverse(id, options = {}) {
    if (!isNonEmptyString(id)) {
      fail('ERR_BAD_ARGS', 'reverse 必须给一个分录 id');
    }
    if (!isPlainObject(options)) {
      fail('ERR_BAD_ARGS', 'reverse 的第二个参数必须是对象');
    }
    const { date } = options;
    if (date !== undefined && !isValidDate(date)) {
      fail('ERR_BAD_ARGS', `冲正日期不合法：${String(date)}`);
    }

    const original = byId.get(id);
    if (!original) {
      fail('ERR_UNKNOWN_ENTRY', `分录不存在：${id}`, { id });
    }
    if (original.id.endsWith(':rev') || reversedIds.has(original.id)) {
      fail('ERR_ALREADY_REVERSED', `分录已经冲正过：${id}`, { id });
    }

    const reversalDate = date ?? original.date;
    ensureUnlocked(reversalDate);

    const reversal = {
      id: `${original.id}:rev`,
      date: reversalDate,
      postings: original.postings.map((posting) => ({
        account: posting.account,
        amount: -posting.amount,
      })),
    };
    reversedIds.add(original.id);
    return admit(reversal);
  }

  function lockPeriod(options) {
    if (!isPlainObject(options) || !isValidDate(options.through)) {
      fail('ERR_BAD_ARGS', 'lockPeriod 需要合法的 through 日期');
    }
    const { through } = options;
    if (lockedThrough !== null && through < lockedThrough) {
      fail(
        'ERR_PERIOD_LOCKED',
        `封账日期不能往回推：${through} < ${lockedThrough}`,
        { through, lockedThrough },
      );
    }
    lockedThrough = through;
    return { lockedThrough };
  }

  function balance(query = {}) {
    if (!isPlainObject(query)) {
      fail('ERR_BAD_ARGS', 'balance 的入参必须是对象');
    }
    if (query.asOf !== undefined && !isValidDate(query.asOf)) {
      fail('ERR_BAD_ARGS', `asOf 日期不合法：${String(query.asOf)}`);
    }
    const account = accounts.get(query.account);
    if (!account) {
      fail('ERR_UNKNOWN_ACCOUNT', `账户不存在：${String(query.account)}`, {
        account: query.account,
      });
    }

    let net = 0;
    let debit = 0;
    let credit = 0;
    for (const entry of entries) {
      if (query.asOf !== undefined && entry.date > query.asOf) continue;
      for (const posting of entry.postings) {
        if (posting.account !== account.id) continue;
        net += posting.amount;
        if (posting.amount > 0) debit += posting.amount;
        else credit -= posting.amount;
      }
    }
    return { account: account.id, currency: account.currency, net, debit, credit };
  }

  function trialBalance(query = {}) {
    if (!isPlainObject(query)) {
      fail('ERR_BAD_ARGS', 'trialBalance 的入参必须是对象');
    }
    const { asOf } = query;
    if (asOf !== undefined && !isValidDate(asOf)) {
      fail('ERR_BAD_ARGS', `asOf 日期不合法：${String(asOf)}`);
    }

    const nets = new Map();
    for (const entry of entries) {
      if (asOf !== undefined && entry.date > asOf) continue;
      for (const posting of entry.postings) {
        nets.set(posting.account, (nets.get(posting.account) ?? 0) + posting.amount);
      }
    }

    const byType = ACCOUNT_TYPES.map((type) => {
      let net = 0;
      for (const [id, value] of nets) {
        if (accounts.get(id).type === type) net += value;
      }
      const normal = type === 'asset' || type === 'expense' ? net : -net;
      return { type, net, normal };
    });
    const total = byType.reduce((sum, one) => sum + one.net, 0);

    return { asOf: asOf ?? null, byType, total, balanced: total === 0 };
  }

  function listEntries(query = {}) {
    if (!isPlainObject(query)) {
      fail('ERR_BAD_ARGS', 'entries 的入参必须是对象');
    }
    const { from, to } = query;
    if ((from !== undefined && !isValidDate(from)) || (to !== undefined && !isValidDate(to))) {
      fail('ERR_BAD_ARGS', 'from / to 必须是 YYYY-MM-DD 的真实日子');
    }

    return entries
      .filter((entry) =>
        (from === undefined || entry.date >= from) &&
        (to === undefined || entry.date <= to))
      .slice()
      .sort((a, b) =>
        a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq)
      .map((entry) => ({ ...entryView(entry), seq: entry.seq }));
  }

  function stats() {
    return {
      accounts: accounts.size,
      entries: entries.length,
      postings: entries.reduce((sum, entry) => sum + entry.postings.length, 0),
      reversals: reversedIds.size,
      lockedThrough,
    };
  }

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
