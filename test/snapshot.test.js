import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { createMemoryLog } from '../lib/log.js';

function seeded() {
  const log = createMemoryLog();
  const store = createStore({ log });
  const first = store.begin();
  store.set(first, 'a', '1');
  store.set(first, 'b', '1');
  store.commit(first);
  const second = store.begin();
  store.set(second, 'a', '2');
  store.del(second, 'b');
  store.commit(second);
  return { log, store };
}

test('checkpoint 之后日志变短，读到的东西一个字不变', () => {
  const { log, store } = seeded();
  const before = store.stats().walBytes;
  const out = store.checkpoint();
  assert.equal(out.version, 2);
  assert.equal(out.walBytes < before, true);
  assert.equal(log.size, out.walBytes);
  assert.deepEqual(store.get('a'), { key: 'a', value: '2', version: 2 });
  assert.deepEqual(store.history('a'), [
    { version: 1, value: '1' },
    { version: 2, value: '2' },
  ]);
  assert.deepEqual(store.history('b'), [
    { version: 1, value: '1' },
    { version: 2, value: null },
  ]);
  assert.deepEqual(store.get('a', 1), { key: 'a', value: '1', version: 1 });
});

test('checkpoint 过的日志恢复出来还是一样，接着写也没问题', () => {
  const { log, store } = seeded();
  store.checkpoint();
  const revivedLog = createMemoryLog(log.bytes());
  const revived = createStore({ log: revivedLog });
  assert.equal(revived.stats().version, 2);
  assert.deepEqual(revived.scan().map((item) => item.key), ['a']);
  assert.equal(revived.get('a').value, '2');
  assert.deepEqual(revived.get('a', 1), { key: 'a', value: '1', version: 1 });

  const txn = revived.begin();
  revived.set(txn, 'c', '3');
  revived.commit(txn);
  const again = createStore({ log: createMemoryLog(revivedLog.bytes()) });
  assert.equal(again.get('c').value, '3');
  assert.equal(again.stats().version, 3);
});

test('还有没提交的事务就不许 checkpoint', () => {
  const { store } = seeded();
  store.begin();
  let code = '';
  try {
    store.checkpoint();
  } catch (err) {
    code = err.code;
  }
  assert.equal(code, 'ERR_PENDING_TXNS');
});

test('checkpoint 之间来回折腾，日志不会一直涨', () => {
  const { log, store } = seeded();
  store.checkpoint();
  const first = store.stats().walBytes;
  for (let i = 0; i < 5; i++) {
    const txn = store.begin();
    store.set(txn, 'a', `v${i}`);
    store.commit(txn);
  }
  assert.equal(store.stats().walBytes > first, true);
  const out = store.checkpoint();
  assert.equal(store.stats().walBytes, out.walBytes);
  assert.equal(out.walBytes < first + 5 * 40, true);
  assert.equal(log.size, out.walBytes);
  assert.equal(store.get('a').value, 'v4');
  assert.equal(store.history('a').length, 7);
});
