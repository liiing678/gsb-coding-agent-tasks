import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'MvccError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

test('一个事务里写几条，提交后一起可见', () => {
  const store = createStore();
  const txn = store.begin();
  assert.equal(txn.id, 'txn-1');
  assert.equal(txn.snapshot, 0);
  assert.equal(txn.state, 'active');

  txn.put('a', 1);
  txn.put('b', { n: 1 });
  txn.delete('c');
  assert.equal(txn.get('a'), 1);
  assert.equal(store.get('a'), undefined, '没提交之前外面看不到');

  assert.deepEqual(txn.commit(), { commitTs: 1, writes: 3 });
  assert.equal(txn.state, 'committed');
  assert.equal(store.get('a'), 1);
  assert.deepEqual(store.get('b'), { n: 1 });
  assert.deepEqual(store.scan(), [{ key: 'a', value: 1 }, { key: 'b', value: { n: 1 } }]);
});

test('快照隔离：事务看不到自己开始之后提交的改动', () => {
  const store = createStore();
  store.begin().commit();                                  // commitTs 1
  const early = store.begin();                             // snapshot 1
  const late = store.begin();                              // snapshot 1
  late.put('a', 1);
  late.commit();                                           // commitTs 2

  assert.equal(early.get('a'), undefined);
  assert.deepEqual(early.scan(), []);
  assert.equal(store.get('a'), 1);
  assert.equal(early.commit().commitTs, 3);
});

test('回滚丢掉写集，库上什么都没变', () => {
  const store = createStore();
  const seed = store.begin();
  seed.put('a', 1);
  seed.commit();

  const txn = store.begin();
  txn.put('a', 2);
  txn.delete('b');
  assert.equal(txn.get('a'), 2);
  assert.equal(txn.abort(), true);
  assert.equal(txn.state, 'aborted');
  assert.equal(store.get('a'), 1);
  assert.equal(txn.abort(), false, '已经结束的事务再 abort 返回 false');
  expectError(() => txn.get('a'), 'ERR_TXN_CLOSED');
  expectError(() => txn.commit(), 'ERR_TXN_CLOSED');
  assert.equal(store.stats().aborts, 1);
});

test('两个事务改同一个 key，后提交的报冲突', () => {
  const store = createStore();
  const seed = store.begin();
  seed.put('a', 1);
  seed.commit();                                           // commitTs 1

  const first = store.begin();                             // snapshot 1
  const second = store.begin();                            // snapshot 1
  first.put('a', 2);
  first.put('z', 9);
  assert.deepEqual(first.commit(), { commitTs: 2, writes: 2 });

  second.put('a', 3);
  second.put('y', 4);
  const err = expectError(() => second.commit(), 'ERR_CONFLICT');
  assert.equal(err.details.txnId, 'txn-3');
  assert.deepEqual(err.details.keys, ['a'], '只报真正撞上的 key');
  assert.equal(second.state, 'aborted');
  assert.equal(store.get('a'), 2, '先提交的那份留着');
  assert.equal(store.get('y'), undefined, '冲突事务整条丢掉');
  assert.equal(store.stats().conflicts, 1);
});

test('没写过的 key 被别人改了不算冲突', () => {
  const store = createStore();
  const seed = store.begin();
  seed.put('a', 1);
  seed.commit();

  const reader = store.begin();
  assert.equal(reader.get('a'), 1);
  const writer = store.begin();
  writer.put('a', 7);
  writer.commit();
  assert.equal(reader.commit().commitTs, 3, '只读的事务不该被拦下');

  const other = store.begin();
  other.put('b', 1);
  assert.equal(other.commit().commitTs, 4);
});

test('空写集也能提交，占一个版本号', () => {
  const store = createStore();
  assert.deepEqual(store.begin().commit(), { commitTs: 1, writes: 0 });
  assert.equal(store.stats().commitTs, 1);
  assert.equal(store.stats().commits, 1);
});

test('写进去的深拷贝，读出来的也是深拷贝', () => {
  const store = createStore();
  const payload = { list: [1, 2], nested: { n: 1 } };
  const txn = store.begin();
  txn.put('a', payload);
  payload.nested.n = 99;
  txn.commit();

  assert.deepEqual(store.get('a'), { list: [1, 2], nested: { n: 1 } });
  const read = store.get('a');
  read.nested.n = 5;
  read.list.push(3);
  assert.deepEqual(store.get('a'), { list: [1, 2], nested: { n: 1 } });
});

test('key 和 value 不合法时报哪个码', () => {
  const store = createStore({ maxKeyLength: 8 });
  const txn = store.begin();
  expectError(() => txn.put('', 1), 'ERR_BAD_KEY');
  expectError(() => txn.put(7, 1), 'ERR_BAD_KEY');
  expectError(() => txn.put('x'.repeat(9), 1), 'ERR_BAD_KEY');
  expectError(() => txn.put('a', undefined), 'ERR_BAD_VALUE');
  expectError(() => store.get(7), 'ERR_BAD_KEY');
  expectError(() => txn.scan(1), 'ERR_BAD_RANGE');
  expectError(() => txn.scan('z', 'a'), 'ERR_BAD_RANGE');
});
