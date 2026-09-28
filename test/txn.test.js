import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { createMemoryLog } from '../lib/log.js';

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'KVError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

test('提交之后才读得到，版本号从 1 开始', () => {
  const store = createStore();
  const txn = store.begin();
  store.set(txn, 'user:1', 'ann');
  assert.equal(store.get('user:1'), null);
  const out = store.commit(txn);
  assert.equal(out.version, 1);
  assert.deepEqual(store.get('user:1'), { key: 'user:1', value: 'ann', version: 1 });
  assert.equal(store.stats().version, 1);
});

test('回滚的事务什么都不留，还能接着开新事务', () => {
  const store = createStore();
  const first = store.begin();
  store.set(first, 'a', '1');
  store.rollback(first);
  expectError(() => store.set(first, 'b', '2'), 'ERR_TXN_CLOSED');
  const second = store.begin();
  store.set(second, 'a', '9');
  store.commit(second);
  assert.deepEqual(store.get('a'), { key: 'a', value: '9', version: 1 });
  assert.equal(store.history('a').length, 1);
});

test('事务对象和字符串 id 都能用', () => {
  const store = createStore();
  const txn = store.begin();
  store.set(txn.id, 'a', '1');
  store.commit(txn.id);
  assert.equal(store.get('a').value, '1');
  expectError(() => store.set(txn.id, 'b', '2'), 'ERR_TXN_CLOSED');
});

test('同一个事务里改两次，最后那次生效，历史两条都留着', () => {
  const store = createStore();
  const txn = store.begin();
  store.set(txn, 'a', '1');
  store.set(txn, 'a', '2');
  store.commit(txn);
  assert.equal(store.get('a').value, '2');
  assert.deepEqual(store.history('a'), [
    { version: 1, value: '1' },
    { version: 1, value: '2' },
  ]);
});

test('删除是墓碑，之后按版本还能看到旧值', () => {
  const store = createStore();
  const first = store.begin();
  store.set(first, 'a', '1');
  store.commit(first);
  const second = store.begin();
  store.del(second, 'a');
  store.commit(second);
  assert.equal(store.get('a'), null);
  assert.deepEqual(store.get('a', 1), { key: 'a', value: '1', version: 1 });
  assert.deepEqual(store.history('a'), [
    { version: 1, value: '1' },
    { version: 2, value: null },
  ]);
  assert.deepEqual(store.scan('', 1).map((item) => item.key), ['a']);
  assert.deepEqual(store.scan(''), []);
});

test('空事务也占一个版本号', () => {
  const store = createStore();
  store.commit(store.begin());
  store.commit(store.begin());
  assert.equal(store.stats().version, 2);
});

test('事务只能提交一次', () => {
  const store = createStore();
  const txn = store.begin();
  store.commit(txn);
  expectError(() => store.commit(txn), 'ERR_TXN_CLOSED');
});

test('不认识的事务号', () => {
  const store = createStore();
  expectError(() => store.set('t-404', 'a', '1'), 'ERR_UNKNOWN_TXN');
  expectError(() => store.commit('t-404'), 'ERR_UNKNOWN_TXN');
});

test('key 和 value 的形态卡在写入前', () => {
  const store = createStore();
  const txn = store.begin();
  expectError(() => store.set(txn, '', 'v'), 'ERR_BAD_KEY');
  expectError(() => store.set(txn, 42, 'v'), 'ERR_BAD_KEY');
  expectError(() => store.set(txn, 'a', 42), 'ERR_BAD_VALUE');
  expectError(() => store.set(txn, 'a', Buffer.from('x')), 'ERR_BAD_VALUE');
  expectError(() => store.del(txn, ''), 'ERR_BAD_KEY');
  assert.equal(store.stats().walBytes, 0);
});

test('value 超过上限直接拒，日志不动', () => {
  const log = createMemoryLog();
  const store = createStore({ log, maxValueBytes: 4 });
  const txn = store.begin();
  expectError(() => store.set(txn, 'a', '12345'), 'ERR_VALUE_TOO_LARGE');
  assert.equal(log.size, 0);
  store.set(txn, 'a', '1234');
  store.commit(txn);
  assert.equal(store.get('a').value, '1234');
});

test('scan 按 key 排序，前缀能筛', () => {
  const store = createStore();
  const txn = store.begin();
  store.set(txn, 'b', '2');
  store.set(txn, 'a/1', '1');
  store.set(txn, 'a/2', '2');
  store.commit(txn);
  assert.deepEqual(store.scan().map((item) => item.key), ['a/1', 'a/2', 'b']);
  assert.deepEqual(store.scan('a/').map((item) => item.key), ['a/1', 'a/2']);
});

test('版本号越界要报错', () => {
  const store = createStore();
  store.commit(store.begin());
  expectError(() => store.get('a', 2), 'ERR_BAD_VERSION');
  expectError(() => store.get('a', -1), 'ERR_BAD_VERSION');
  expectError(() => store.scan('', 1.5), 'ERR_BAD_VERSION');
  assert.equal(store.get('a', 0), null);
});

test('stats 把该数的都数出来', () => {
  const store = createStore();
  const txn = store.begin();
  store.set(txn, 'a', 'hello');
  store.set(txn, 'b', 'world!');
  store.commit(txn);
  const open = store.begin();
  store.set(open, 'c', 'x');
  const stats = store.stats();
  assert.equal(stats.version, 1);
  assert.equal(stats.keys, 2);
  assert.equal(stats.entries, 2);
  assert.equal(stats.liveBytes, 11);
  assert.equal(stats.pendingTxns, 1);
  assert.equal(stats.walBytes > 0, true);
  assert.deepEqual(stats.recovery, { reason: 'clean', frames: 0, droppedBytes: 0 });
});
