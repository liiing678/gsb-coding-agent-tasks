import test from 'node:test';
import assert from 'node:assert/strict';

import { createLedger } from '../lib/ledger.js';
import { accounts, code, failure, fresh, sale } from './util.js';

test('记得上就记得上，余额和试算表都对得上', () => {
  const ledger = fresh();
  const back = ledger.post(sale('E1', '2026-03-01', 12_000));
  assert.deepEqual(back, {
    id: 'E1',
    date: '2026-03-01',
    postings: [
      { account: 'cash', amount: 12_000 },
      { account: 'sales', amount: -12_000 },
    ],
  });
  ledger.post(sale('E2', '2026-03-02', 3_000, 'ar'));

  assert.deepEqual(ledger.balance({ account: 'cash' }),
    { account: 'cash', currency: 'CNY', net: 12_000, debit: 12_000, credit: 0 });
  assert.deepEqual(ledger.balance({ account: 'sales' }),
    { account: 'sales', currency: 'CNY', net: -15_000, debit: 0, credit: 15_000 });

  const trial = ledger.trialBalance();
  assert.equal(trial.total, 0);
  assert.equal(trial.balanced, true);
  assert.deepEqual(trial.byType.filter((one) => one.net !== 0),
    [{ type: 'asset', net: 15_000, normal: 15_000 }, { type: 'income', net: -15_000, normal: 15_000 }]);
  // 拿到手的分录是拷贝，改它不影响账本
  back.postings[0].amount = 1;
  assert.equal(ledger.balance({ account: 'cash' }).net, 12_000);
});

test('不平的分录当场拦住，说清是哪个币种差多少', () => {
  const ledger = fresh();
  const bad = failure(() => ledger.post({
    id: 'E1',
    date: '2026-03-01',
    postings: [
      { account: 'cash', amount: 100 },
      { account: 'sales', amount: -99 },
    ],
  }));
  assert.equal(bad.code, 'ERR_UNBALANCED');
  assert.equal(bad.details.currency, 'CNY');
  assert.equal(bad.details.sum, 1);
  assert.equal(ledger.stats().entries, 0);
});

test('币种各平各的，跨币种不能互相抵', () => {
  const ledger = fresh();
  const mixed = failure(() => ledger.post({
    id: 'E1',
    date: '2026-03-01',
    postings: [
      { account: 'cash', amount: 500 },
      { account: 'usd-loan', amount: -500 },
    ],
  }));
  assert.equal(mixed.code, 'ERR_UNBALANCED');

  ledger.post({
    id: 'E2',
    date: '2026-03-01',
    postings: [
      { account: 'cash', amount: 500 },
      { account: 'sales', amount: -500 },
      { account: 'usd-cash', amount: 900 },
      { account: 'usd-loan', amount: -900 },
    ],
  });
  assert.equal(ledger.trialBalance().balanced, true);
  assert.equal(ledger.balance({ account: 'usd-cash' }).net, 900);
});

test('分录本身不合法各有各的码', () => {
  const ledger = fresh();
  assert.equal(code(() => ledger.post(null)), 'ERR_BAD_ARGS');
  assert.equal(code(() => ledger.post({ id: '', date: '2026-03-01', postings: [] })),
    'ERR_BAD_ENTRY');
  assert.equal(code(() => ledger.post({
    id: 'E1',
    date: '2026-03-01',
    postings: [{ account: 'cash', amount: 100 }],
  })), 'ERR_BAD_ENTRY');
  assert.equal(code(() => ledger.post(sale('E2', '2026-03-01', 100, 'nowhere'))),
    'ERR_UNKNOWN_ACCOUNT');
  assert.equal(code(() => ledger.post({
    id: 'E3',
    date: '2026-03-01',
    postings: [{ account: 'cash', amount: 0 }, { account: 'sales', amount: 0 }],
  })), 'ERR_BAD_AMOUNT');
  assert.equal(code(() => ledger.post({
    id: 'E4',
    date: '2026-03-01',
    postings: [{ account: 'cash', amount: 1.5 }, { account: 'sales', amount: -1.5 }],
  })), 'ERR_BAD_AMOUNT');
  assert.equal(code(() => ledger.post({
    id: 'E5',
    date: '2026-03-01',
    postings: [
      { account: 'cash', amount: 2 ** 53 },
      { account: 'sales', amount: -(2 ** 53) },
    ],
  })), 'ERR_BAD_AMOUNT');

  ledger.post(sale('E6', '2026-03-01', 100));
  assert.equal(code(() => ledger.post(sale('E6', '2026-03-02', 100))), 'ERR_DUPLICATE_ENTRY');
  assert.equal(code(() => ledger.post({
    id: 'E7',
    date: '2026-03-01',
    postings: [null, { account: 'sales', amount: -1 }],
  })), 'ERR_BAD_ENTRY');
});

test('日期写错就是 ERR_BAD_ARGS，二月三十号不算数', () => {
  const ledger = fresh();
  assert.equal(code(() => ledger.post({ id: 'E1', date: '3/1/2026', postings: [] })),
    'ERR_BAD_ARGS');
  assert.equal(code(() => ledger.post(sale('E1', '2026-02-30', 100))), 'ERR_BAD_ARGS');
  assert.equal(code(() => ledger.post(sale('E1', '2024-02-29', 100))), null);
});

test('冲正把余额顶回去，冲过的不能再冲', () => {
  const ledger = fresh();
  ledger.post(sale('E1', '2026-03-01', 12_000));
  const back = ledger.reverse('E1', { date: '2026-03-10' });
  assert.deepEqual(back, {
    id: 'E1:rev',
    date: '2026-03-10',
    postings: [
      { account: 'cash', amount: -12_000 },
      { account: 'sales', amount: 12_000 },
    ],
  });
  assert.equal(ledger.balance({ account: 'cash' }).net, 0);
  assert.equal(ledger.balance({ account: 'cash', asOf: '2026-03-01' }).net, 12_000);
  assert.equal(ledger.trialBalance().balanced, true);

  assert.equal(code(() => ledger.reverse('E1')), 'ERR_ALREADY_REVERSED');
  assert.equal(code(() => ledger.reverse('E1:rev')), 'ERR_ALREADY_REVERSED');
  assert.equal(code(() => ledger.reverse('E404')), 'ERR_UNKNOWN_ENTRY');
  assert.equal(code(() => ledger.reverse(null)), 'ERR_BAD_ARGS');
  // 不给日期就跟着原分录走
  ledger.post(sale('E2', '2026-03-11', 500));
  assert.equal(ledger.reverse('E2').date, '2026-03-11');
});

test('封账之后那一段谁也别想动', () => {
  const ledger = fresh();
  ledger.post(sale('E1', '2026-01-15', 100));
  assert.deepEqual(ledger.lockPeriod({ through: '2026-01-31' }),
    { lockedThrough: '2026-01-31' });

  const locked = failure(() => ledger.post(sale('E2', '2026-01-20', 100)));
  assert.equal(locked.code, 'ERR_PERIOD_LOCKED');
  assert.equal(locked.details.lockedThrough, '2026-01-31');
  assert.equal(code(() => ledger.reverse('E1', { date: '2026-01-20' })), 'ERR_PERIOD_LOCKED');
  // 锁定期里连重复 id 都得先报期间的问题
  assert.equal(code(() => ledger.post(sale('E1', '2026-01-20', 100))), 'ERR_PERIOD_LOCKED');

  assert.equal(code(() => ledger.post(sale('E3', '2026-02-01', 100))), null);
  assert.equal(code(() => ledger.lockPeriod({ through: '2026-01-01' })), 'ERR_PERIOD_LOCKED');
  assert.equal(code(() => ledger.lockPeriod({ through: '2026-02-30' })), 'ERR_BAD_ARGS');
  assert.equal(code(() => ledger.lockPeriod({})), 'ERR_BAD_ARGS');
  // 封账日期可以原地不动
  assert.deepEqual(ledger.lockPeriod({ through: '2026-01-31' }),
    { lockedThrough: '2026-01-31' });
});

test('账户表自己有问题就是 ERR_BAD_CONFIG', () => {
  assert.equal(code(() => createLedger()), 'ERR_BAD_CONFIG');
  assert.equal(code(() => createLedger({ accounts: [] })), 'ERR_BAD_CONFIG');
  assert.equal(code(() => createLedger({ accounts: 'cash' })), 'ERR_BAD_CONFIG');
  assert.equal(code(() => createLedger({ accounts: [null] })), 'ERR_BAD_CONFIG');
  assert.equal(code(() => createLedger({ accounts: [{ id: 'a', type: 'cash', currency: 'CNY' }] })),
    'ERR_BAD_CONFIG');
  assert.equal(code(() => createLedger({
    accounts: [{ id: 'a', type: 'asset', currency: '' }],
  })), 'ERR_BAD_CONFIG');
  assert.equal(code(() => createLedger({
    accounts: [accounts[0], accounts[0]],
  })), 'ERR_BAD_CONFIG');
});
