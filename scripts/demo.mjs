import { createEngine } from '../lib/engine.js';

const engine = createEngine({
  tables: {
    users: [
      { id: 1, name: 'ann', tier: 'gold' },
      { id: 2, name: 'bob', tier: 'silver' },
      { id: 3, name: 'cid', tier: 'gold' },
    ],
    orders: [
      { id: 'o1', userId: 1, amount: 30, status: 'paid' },
      { id: 'o2', userId: 1, amount: 70, status: 'paid' },
      { id: 'o3', userId: 2, amount: 20, status: 'refunded' },
      { id: 'o4', userId: 9, amount: 5, status: 'paid' },
      { id: 'o5', userId: 3, amount: null, status: 'paid' },
    ],
  },
});

console.log('querylite demo');

console.log('[1] 过滤 + 投影 + 排序，null 排最后');
const paid = engine.execute({
  from: 'orders',
  select: ['id', 'amount'],
  where: [{ column: 'status', op: '=', value: 'paid' }],
  orderBy: [{ column: 'amount', direction: 'desc' }],
});
console.log(`    ${paid.rows.map((one) => `${one.id}(${one.amount})`).join(' ')}`);

console.log('[2] 类型不一样就当不知道：字符串 1 不等于数字 1');
const wrongType = engine.execute({
  from: 'orders',
  select: ['id'],
  where: [{ column: 'userId', op: '=', value: '1' }],
});
console.log(`    userId='1' 命中 ${wrongType.rows.length} 行`);

console.log('[3] 左连接之后按等级分组');
const byTier = engine.execute({
  from: 'orders',
  join: { table: 'users', type: 'left', on: [{ left: 'userId', right: 'id' }] },
  groupBy: ['users.tier'],
  aggregates: [
    { as: 'total', fn: 'sum', column: 'orders.amount' },
    { as: 'n', fn: 'count' },
  ],
  orderBy: [{ column: 'total', direction: 'desc' }],
});
for (const row of byTier.rows) {
  console.log(`    ${row['users.tier'] ?? '(没挂上)'} total=${row.total} n=${row.n}`);
}

console.log('[4] 换成内连接，再用 having 砍掉小分组');
const inner = engine.execute({
  from: 'orders',
  join: { table: 'users', type: 'inner', on: [{ left: 'userId', right: 'id' }] },
  groupBy: ['users.tier'],
  aggregates: [{ as: 'total', fn: 'sum', column: 'orders.amount' }],
  having: [{ column: 'total', op: '>', value: 50 }],
});
console.log(`    ${inner.rows.map((one) => `${one['users.tier']} total=${one.total}`).join(' ')}`);

console.log('[5] 统计');
console.log(`    ${JSON.stringify(byTier.stats)}`);
