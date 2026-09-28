import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../lib/engine.js';

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'QueryError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

const db = () => createEngine({
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
    tags: [{ id: 1, tag: 'a' }, { id: 2, tag: 'a' }, { id: 3, tag: 'b' }],
    mixed: [{ k: 1 }, { k: 'two' }],
    empty: { columns: ['id', 'v'], rows: [] },
  },
});

test('左连接之后按右表的列分组，补 null 的那行也算一组', () => {
  const { rows, stats } = db().execute({
    from: 'orders',
    join: { table: 'users', type: 'left', on: [{ left: 'userId', right: 'id' }] },
    groupBy: ['users.tier'],
    aggregates: [
      { as: 'total', fn: 'sum', column: 'orders.amount' },
      { as: 'n', fn: 'count' },
    ],
    orderBy: [{ column: 'total', direction: 'desc' }],
  });
  assert.deepEqual(rows, [
    { 'users.tier': 'gold', total: 100, n: 3 },
    { 'users.tier': 'silver', total: 20, n: 1 },
    { 'users.tier': null, total: 5, n: 1 },
  ]);
  assert.deepEqual(stats, { scanned: 5, joined: 5, filtered: 5, groups: 3, returned: 3 });
});

test('内连接丢掉挂不上的行，having 再砍小分组', () => {
  const { rows, stats } = db().execute({
    from: 'orders',
    join: { table: 'users', type: 'inner', on: [{ left: 'userId', right: 'id' }] },
    groupBy: ['users.tier'],
    aggregates: [{ as: 'total', fn: 'sum', column: 'orders.amount' }],
    having: [{ column: 'total', op: '>', value: 50 }],
  });
  assert.deepEqual(rows, [{ 'users.tier': 'gold', total: 100 }]);
  assert.deepEqual(stats, { scanned: 5, joined: 4, filtered: 4, groups: 2, returned: 1 });
});

test('不分组就是整表一组，空表也照样给一行', () => {
  const { rows, stats } = db().execute({
    from: 'empty',
    aggregates: [
      { as: 'n', fn: 'count' },
      { as: 'total', fn: 'sum', column: 'v' },
      { as: 'mn', fn: 'min', column: 'v' },
    ],
  });
  assert.deepEqual(rows, [{ n: 0, total: null, mn: null }]);
  assert.equal(stats.groups, 1);
  assert.equal(stats.returned, 1);
});

test('分了组但是一行都没有，就是零行', () => {
  const { rows, stats } = db().execute({
    from: 'empty',
    groupBy: ['id'],
    aggregates: [{ as: 'n', fn: 'count' }],
  });
  assert.deepEqual(rows, []);
  assert.equal(stats.groups, 0);
});

test('聚合忽略 null，count 分带列和不带列', () => {
  const { rows } = db().execute({
    from: 'orders',
    aggregates: [
      { as: 'rows', fn: 'count' },
      { as: 'withAmount', fn: 'count', column: 'amount' },
      { as: 'total', fn: 'sum', column: 'amount' },
      { as: 'avg', fn: 'avg', column: 'amount' },
      { as: 'min', fn: 'min', column: 'amount' },
      { as: 'max', fn: 'max', column: 'amount' },
    ],
  });
  assert.deepEqual(rows, [{ rows: 5, withAmount: 4, total: 125, avg: 31.25, min: 5, max: 70 }]);
});

test('distinct 去重，字符串也能 min / max', () => {
  const engine = db();
  assert.deepEqual(
    engine.execute({
      from: 'tags',
      aggregates: [
        { as: 'uniq', fn: 'count', column: 'tag', distinct: true },
        { as: 'all', fn: 'count', column: 'tag' },
      ],
    }).rows,
    [{ uniq: 2, all: 3 }],
  );
  assert.deepEqual(
    engine.execute({
      from: 'users',
      aggregates: [{ as: 'mn', fn: 'min', column: 'name' }, { as: 'mx', fn: 'max', column: 'name' }],
    }).rows,
    [{ mn: 'ann', mx: 'cid' }],
  );
});

test('having 和 orderBy 都能用聚合别名', () => {
  const { rows } = db().execute({
    from: 'orders',
    groupBy: ['status'],
    aggregates: [{ as: 'n', fn: 'count' }],
    having: [{ column: 'n', op: '>=', value: 2 }],
    orderBy: [{ column: 'n', direction: 'desc' }, { column: 'status' }],
  });
  assert.deepEqual(rows, [{ status: 'paid', n: 4 }]);
});

test('聚合遇到不该有的东西时报哪个码', () => {
  const engine = db();
  expectError(() => engine.execute({ from: 'orders', aggregates: [{ as: 'x', fn: 'median', column: 'amount' }] }), 'ERR_BAD_AGG');
  expectError(() => engine.execute({ from: 'orders', aggregates: [{ as: 'x', fn: 'sum', column: 'status' }] }), 'ERR_BAD_AGG');
  expectError(() => engine.execute({ from: 'orders', aggregates: [{ as: 'x', fn: 'avg' }] }), 'ERR_BAD_AGG');
  expectError(() => engine.execute({ from: 'mixed', aggregates: [{ as: 'x', fn: 'min', column: 'k' }] }), 'ERR_BAD_AGG');
  expectError(() => engine.execute({ from: 'orders', aggregates: [{ as: 'n', fn: 'count' }, { as: 'n', fn: 'count' }] }), 'ERR_BAD_QUERY');
  expectError(() => engine.execute({ from: 'orders', aggregates: [{ fn: 'count' }] }), 'ERR_BAD_QUERY');
  expectError(() => engine.execute({ from: 'orders', groupBy: 'status' }), 'ERR_BAD_QUERY');
  expectError(() => engine.execute({ from: 'orders', having: [{ column: 'nope', op: '>', value: 1 }] }), 'ERR_UNKNOWN_COLUMN');
});
