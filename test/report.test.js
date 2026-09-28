import test from 'node:test';
import assert from 'node:assert/strict';

import { code, fresh, sale } from './util.js';

const book = () => {
  const ledger = fresh();
  ledger.post({
    id: 'E1',
    date: '2026-03-01',
    postings: [
      { account: 'cash', amount: 12_000 },
      { account: 'deposit', amount: -7_000 },
      { account: 'sales', amount: -5_000 },
    ],
  });
  ledger.post(sale('E2', '2026-03-05', 3_000, 'ar'));
  ledger.post({
    id: 'E3',
    date: '2026-03-05',
    postings: [
      { account: 'usd-cash', amount: 900 },
      { account: 'usd-loan', amount: -900 },
    ],
  });
  return ledger;
};

test('余额按日期累计，当天算在内', () => {
  const ledger = book();
  assert.deepEqual(ledger.balance({ account: 'cash' }),
    { account: 'cash', currency: 'CNY', net: 12_000, debit: 12_000, credit: 0 });
  assert.equal(ledger.balance({ account: 'sales', asOf: '2026-02-28' }).net, 0);
  assert.equal(ledger.balance({ account: 'sales', asOf: '2026-03-01' }).net, -5_000);
  assert.equal(ledger.balance({ account: 'sales', asOf: '2026-03-05' }).net, -8_000);
  assert.equal(ledger.balance({ account: 'deposit' }).credit, 7_000);
  assert.equal(code(() => ledger.balance({})), 'ERR_UNKNOWN_ACCOUNT');
  assert.equal(code(() => ledger.balance()), 'ERR_UNKNOWN_ACCOUNT');
  assert.equal(code(() => ledger.balance(5)), 'ERR_BAD_ARGS');
  assert.equal(code(() => ledger.balance({ account: 'cash', asOf: '2026-3-1' })), 'ERR_BAD_ARGS');
});

test('试算表按账户类型汇总，两边口径都给', () => {
  const ledger = book();
  const trial = ledger.trialBalance();
  assert.equal(trial.total, 0);
  assert.equal(trial.balanced, true);
  assert.deepEqual(trial.byType.map((one) => one.type),
    ['asset', 'liability', 'equity', 'income', 'expense']);
  assert.deepEqual(trial.byType.find((one) => one.type === 'asset'),
    { type: 'asset', net: 15_900, normal: 15_900 });
  assert.deepEqual(trial.byType.find((one) => one.type === 'liability'),
    { type: 'liability', net: -7_900, normal: 7_900 });
  assert.deepEqual(trial.byType.find((one) => one.type === 'income'),
    { type: 'income', net: -8_000, normal: 8_000 });

  const early = ledger.trialBalance({ asOf: '2026-03-01' });
  assert.equal(early.balanced, true);
  assert.equal(early.byType.find((one) => one.type === 'asset').net, 12_000);
  assert.equal(code(() => ledger.trialBalance({ asOf: 'oops' })), 'ERR_BAD_ARGS');

  ledger.reverse('E1', { date: '2026-03-08' });
  const after = ledger.trialBalance();
  assert.equal(after.balanced, true);
  assert.equal(after.byType.find((one) => one.type === 'asset').net, 3_900);
  assert.deepEqual(after.byType.find((one) => one.type === 'income'),
    { type: 'income', net: -3_000, normal: 3_000 });
});

test('分录按日期排队，能按区间捞', () => {
  const ledger = book();
  assert.deepEqual(ledger.entries().map((one) => one.id), ['E1', 'E2', 'E3']);
  assert.deepEqual(ledger.entries().map((one) => one.seq), [0, 1, 2]);
  assert.deepEqual(ledger.entries({ from: '2026-03-05' }).map((one) => one.id), ['E2', 'E3']);
  assert.deepEqual(ledger.entries({ to: '2026-03-01' }).map((one) => one.id), ['E1']);
  assert.deepEqual(ledger.entries({ from: '2026-03-05', to: '2026-03-05' }).map((one) => one.id),
    ['E2', 'E3']);
  assert.deepEqual(ledger.entries({ from: '2026-04-01' }), []);
  assert.equal(code(() => ledger.entries({ from: 'bad' })), 'ERR_BAD_ARGS');
  assert.equal(code(() => ledger.entries([])), 'ERR_BAD_ARGS');
});

test('统计口径是全部累计，封账日期跟着封账走', () => {
  const ledger = book();
  assert.deepEqual(ledger.stats(),
    { accounts: 6, entries: 3, postings: 7, reversals: 0, lockedThrough: null });
  ledger.lockPeriod({ through: '2026-02-28' });
  ledger.reverse('E2', { date: '2026-03-09' });
  assert.deepEqual(ledger.stats(),
    { accounts: 6, entries: 4, postings: 9, reversals: 1, lockedThrough: '2026-02-28' });
  assert.equal(ledger.entries({ from: '2026-03-09' }).length, 1);
});
