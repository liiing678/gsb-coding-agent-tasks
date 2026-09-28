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
    mixed: [{ k: 1 }, { k: 'two' }],
    empty: { columns: ['id', 'v'], rows: [] },
  },
});

test('过滤、投影、排序：null 永远排最后', () => {
  const { rows, stats } = db().execute({
    from: 'orders',
    select: ['id', 'amount'],
    where: [{ column: 'status', op: '=', value: 'paid' }],
    orderBy: [{ column: 'amount', direction: 'desc' }],
  });
  assert.deepEqual(rows, [
    { id: 'o2', amount: 70 },
    { id: 'o1', amount: 30 },
    { id: 'o4', amount: 5 },
    { id: 'o5', amount: null },
  ]);
  assert.deepEqual(stats, { scanned: 5, joined: 5, filtered: 4, groups: 0, returned: 4 });
});

test('类型对不上或者沾到 null，都算不知道，一律不通过', () => {
  const engine = db();
  assert.deepEqual(
    engine.execute({ from: 'orders', select: ['id'], where: [{ column: 'amount', op: '>', value: 10 }] }).rows,
    [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }],
  );
  assert.deepEqual(
    engine.execute({ from: 'orders', select: ['id'], where: [{ column: 'userId', op: '=', value: '1' }] }).rows,
    [],
    '数字 1 和字符串 1 不能算相等',
  );
  assert.deepEqual(
    engine.execute({ from: 'orders', select: ['id'], where: [{ column: 'amount', op: '!=', value: 30 }] }).rows,
    [{ id: 'o2' }, { id: 'o3' }, { id: 'o4' }],
    'o5 的 amount 是 null，不等于 30 也不成立',
  );
});

test('in、is-null、not-null', () => {
  const engine = db();
  assert.deepEqual(
    engine.execute({ from: 'orders', select: ['id'], where: [{ column: 'status', op: 'in', values: ['refunded', 'void'] }] }).rows,
    [{ id: 'o3' }],
  );
  assert.deepEqual(
    engine.execute({ from: 'orders', select: ['id'], where: [{ column: 'amount', op: 'is-null' }] }).rows,
    [{ id: 'o5' }],
  );
  assert.equal(
    engine.execute({ from: 'orders', where: [{ column: 'amount', op: 'not-null' }] }).rows.length,
    4,
  );
});

test('不写 select 就把列都带出来，键是列名', () => {
  const { rows } = db().execute({ from: 'orders', where: [{ column: 'id', op: '=', value: 'o3' }] });
  assert.deepEqual(rows, [{ id: 'o3', userId: 2, amount: 20, status: 'refunded' }]);
});

test('排序稳定，按输入顺序兜底', () => {
  const { rows } = db().execute({ from: 'orders', select: ['id', 'status'], orderBy: [{ column: 'status' }] });
  assert.deepEqual(rows.map((one) => one.id), ['o1', 'o2', 'o4', 'o5', 'o3']);
});

test('distinct、offset、limit 的顺序是先去重再截断', () => {
  const engine = db();
  assert.deepEqual(
    engine.execute({ from: 'orders', select: ['status'], distinct: true }).rows,
    [{ status: 'paid' }, { status: 'refunded' }],
  );
  assert.deepEqual(
    engine.execute({ from: 'orders', select: ['id'], orderBy: [{ column: 'id' }], offset: 1, limit: 2 }).rows,
    [{ id: 'o2' }, { id: 'o3' }],
  );
  assert.deepEqual(
    engine.execute({ from: 'orders', select: ['id'], orderBy: [{ column: 'id' }], limit: null }).rows.length,
    5,
  );
});

test('表和列、参数不合法时报哪个码', () => {
  const engine = db();
  expectError(() => engine.execute(null), 'ERR_BAD_QUERY');
  expectError(() => engine.execute({}), 'ERR_BAD_QUERY');
  expectError(() => engine.execute({ from: 'nope' }), 'ERR_UNKNOWN_TABLE');
  expectError(() => engine.execute({ from: 'orders', where: [{ column: 'nope', op: '=', value: 1 }] }), 'ERR_UNKNOWN_COLUMN');
  expectError(() => engine.execute({ from: 'orders', where: [{ column: 'users.name', op: '=', value: 'ann' }] }), 'ERR_UNKNOWN_COLUMN');
  expectError(() => engine.execute({ from: 'orders', select: ['id'], orderBy: [{ column: 'amount' }] }), 'ERR_UNKNOWN_COLUMN');
  expectError(() => engine.execute({ from: 'orders', where: [{ column: 'amount', op: '~', value: 1 }] }), 'ERR_BAD_QUERY');
  expectError(() => engine.execute({ from: 'orders', where: [{ column: 'amount', op: 'in', value: [] }] }), 'ERR_BAD_QUERY');
  expectError(() => engine.execute({ from: 'orders', select: 'amount' }), 'ERR_BAD_QUERY');
  expectError(() => engine.execute({ from: 'orders', distinct: 'yes' }), 'ERR_BAD_QUERY');
  expectError(() => engine.execute({ from: 'orders', limit: 1.5 }), 'ERR_BAD_QUERY');
  expectError(() => engine.execute({ from: 'orders', limit: -1 }), 'ERR_BAD_QUERY');
  expectError(() => engine.execute({ from: 'orders', offset: -1 }), 'ERR_BAD_QUERY');
  expectError(() => engine.execute({ from: 'orders', orderBy: [{ column: 'amount', direction: 'up' }] }), 'ERR_BAD_QUERY');
  expectError(() => engine.execute({ from: 'orders', join: { table: 'nope', on: [{ left: 'userId', right: 'id' }] } }), 'ERR_UNKNOWN_TABLE');
  expectError(() => engine.execute({ from: 'orders', join: { table: 'users', type: 'cross', on: [{ left: 'userId', right: 'id' }] } }), 'ERR_BAD_QUERY');
  expectError(() => engine.execute({ from: 'orders', join: { table: 'users', on: [] } }), 'ERR_BAD_QUERY');
  expectError(() => engine.execute({ from: 'orders', join: { table: 'users', on: [{ left: 'userId' }] } }), 'ERR_BAD_QUERY');
  expectError(() => engine.execute({ from: 'mixed', orderBy: [{ column: 'k' }] }), 'ERR_BAD_QUERY');

  expectError(() => createEngine(), 'ERR_BAD_CONFIG');
  expectError(() => createEngine({ tables: { bad: 'nope' } }), 'ERR_BAD_CONFIG');
  expectError(() => createEngine({ tables: { bad: [1, 2] } }), 'ERR_BAD_CONFIG');
  expectError(() => createEngine({ tables: { bad: { columns: 'id', rows: [] } } }), 'ERR_BAD_CONFIG');
});
