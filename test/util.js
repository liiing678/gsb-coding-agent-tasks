import { createLedger } from '../lib/ledger.js';

export const accounts = [
  { id: 'cash', type: 'asset', currency: 'CNY' },
  { id: 'ar', type: 'asset', currency: 'CNY' },
  { id: 'deposit', type: 'liability', currency: 'CNY' },
  { id: 'sales', type: 'income', currency: 'CNY' },
  { id: 'usd-cash', type: 'asset', currency: 'USD' },
  { id: 'usd-loan', type: 'liability', currency: 'USD' },
];

export const fresh = (overrides = {}) => createLedger({ accounts, ...overrides });

export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

export const failure = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
};

export const sale = (id, date, amount, where = 'cash') => ({
  id,
  date,
  postings: [
    { account: where, amount },
    { account: 'sales', amount: -amount },
  ],
});
