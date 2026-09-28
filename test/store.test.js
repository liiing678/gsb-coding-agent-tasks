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

function seed(store) {
  const txn = store.begin();
  txn.put('a', 1);
  txn.put('b', 2);
  txn.put('c', 3);
  txn.put('d', 4);
  txn.commit();
}

test('最新已提交读：删掉的 key 读出来是 undefined', () => {
  const store = createStore();
  seed(store);
  const txn = store.begin();
  txn.delete('b');
  txn.commit();

  assert.equal(store.get('b'), undefined);
  assert.equal(store.stats().keys, 3);
  assert.deepEqual(store.scan().map((one) => one.key), ['a', 'c', 'd']);
});

test('scan 是半开区间，按 key 升序', () => {
  const store = createStore();
  seed(store);
  assert.deepEqual(store.scan('a', 'c').map((one) => one.key), ['a', 'b']);
  assert.deepEqual(store.scan('b').map((one) => one.key), ['b', 'c', 'd']);
  assert.deepEqual(store.scan(undefined, 'b').map((one) => one.key), ['a']);
  assert.deepEqual(store.scan('c', 'c'), []);
  expectError(() => store.scan('d', 'a'), 'ERR_BAD_RANGE');
});

test('事务里的 scan 能看到自己没提交的写和删', () => {
  const store = createStore();
  seed(store);
  const txn = store.begin();
  txn.put('bb', 22);
  txn.delete('a');
  assert.deepEqual(txn.scan('a', 'c').map((one) => one.key), ['b', 'bb']);
  assert.deepEqual(store.scan().map((one) => one.key), ['a', 'b', 'c', 'd']);
});

test('collect 留最新版本，也留住活跃快照要用的那版', () => {
  const store = createStore();
  for (const value of [1, 2, 3]) {
    const txn = store.begin();
    txn.put('a', value);
    txn.commit();
  }
  assert.equal(store.stats().versions, 3);

  const reader = store.begin();                            // snapshot 3
  const txn = store.begin();
  txn.put('a', 4);
  txn.commit();                                            // commitTs 4

  assert.equal(store.collect(), 2, 'ts 1 / ts 2 两版没人要了');
  assert.equal(store.stats().versions, 2);
  assert.equal(store.stats().collected, 2);
  assert.equal(reader.get('a'), 3, '老快照读到的还是它那一版');
  assert.equal(store.get('a'), 4);

  reader.abort();
  assert.equal(store.collect(), 1);
  assert.equal(store.stats().versions, 1);
});

test('墓碑是最新版本时不能被回收', () => {
  const store = createStore();
  seed(store);
  const txn = store.begin();
  txn.delete('a');
  txn.commit();
  assert.equal(store.collect(), 1, '只回收被墓碑盖住的那一版');
  assert.equal(store.stats().versions, 4);
  assert.equal(store.get('a'), undefined);
  assert.equal(store.stats().keys, 3);
});

test('配置不合法时报哪个码', () => {
  expectError(() => createStore(null), 'ERR_BAD_CONFIG');
  expectError(() => createStore([]), 'ERR_BAD_CONFIG');
  expectError(() => createStore({ maxKeyLength: 0 }), 'ERR_BAD_CONFIG');
  expectError(() => createStore({ maxKeyLength: 1.5 }), 'ERR_BAD_CONFIG');
  assert.equal(createStore({ maxKeyLength: 3 }).begin().state, 'active');
});
