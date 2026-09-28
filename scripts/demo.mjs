import { createLedger } from '../lib/ledger.js';

const ledger = createLedger({
  accounts: [
    { id: 'cash', type: 'asset', currency: 'CNY' },
    { id: 'ar', type: 'asset', currency: 'CNY' },
    { id: 'deposit', type: 'liability', currency: 'CNY' },
    { id: 'sales', type: 'income', currency: 'CNY' },
    { id: 'usd-cash', type: 'asset', currency: 'USD' },
    { id: 'usd-loan', type: 'liability', currency: 'USD' },
  ],
});

console.log('ledger demo');
ledger.post({
  id: 'E1',
  date: '2026-03-01',
  postings: [
    { account: 'cash', amount: 120_00 },
    { account: 'deposit', amount: -70_00 },
    { account: 'sales', amount: -50_00 },
  ],
});
ledger.post({
  id: 'E2',
  date: '2026-03-05',
  postings: [
    { account: 'ar', amount: 30_00 },
    { account: 'sales', amount: -30_00 },
  ],
});
ledger.post({
  id: 'E3',
  date: '2026-03-05',
  postings: [
    { account: 'usd-cash', amount: 9_00 },
    { account: 'usd-loan', amount: -9_00 },
  ],
});

const show = (label, value) => console.log(`  ${label} ${JSON.stringify(value)}`);
show('cash', ledger.balance({ account: 'cash' }));
show('sales', ledger.balance({ account: 'sales', asOf: '2026-03-01' }));
console.log(`  entries ${ledger.entries().map((one) => `${one.id}@${one.date}`).join(' ')}`);

ledger.reverse('E1', { date: '2026-03-08' });
show('cash-after-reverse', ledger.balance({ account: 'cash' }));
console.log(`  trial ${JSON.stringify(ledger.trialBalance().byType.map((one) => `${one.type}:${one.net}/${one.normal}`))}`);
console.log(`  balanced ${ledger.trialBalance().balanced}`);

ledger.lockPeriod({ through: '2026-02-28' });
try {
  ledger.post({
    id: 'E4',
    date: '2026-02-01',
    postings: [{ account: 'cash', amount: 1 }, { account: 'sales', amount: -1 }],
  });
} catch (err) {
  console.log(`  locked ${err.code} ${err.details.date} <= ${err.details.lockedThrough}`);
}
try {
  ledger.post({
    id: 'E5',
    date: '2026-03-09',
    postings: [{ account: 'cash', amount: 1 }, { account: 'sales', amount: -2 }],
  });
} catch (err) {
  console.log(`  unbalanced ${err.code} ${err.details.currency} ${err.details.sum}`);
}
show('stats', ledger.stats());
