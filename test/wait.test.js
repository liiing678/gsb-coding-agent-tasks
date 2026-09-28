import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeadlockDetector } from '../lib/waitgraph.js';

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'WaitError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

function harness(config = {}) {
  let now = 0;
  const detector = createDeadlockDetector({ clock: () => now, maxWaitMs: 100, ...config });
  return { detector, set: (ms) => { now = ms; }, tick: (ms) => { now += ms; } };
}

test('资源空着时 wait 就等于直接拿到', () => {
  const { detector } = harness();
  detector.register({ txId: 'a' });
  assert.deepEqual(detector.wait({ txId: 'a', resource: 'x' }), {
    txId: 'a', resource: 'x', granted: true, waitingFor: null,
  });
  assert.deepEqual(detector.snapshot().resources, [{ resource: 'x', holder: 'a', waiters: [] }]);
});

test('资源被占着时排进等待，等待者按 FIFO 记录', () => {
  const { detector } = harness();
  detector.register({ txId: 'a' });
  detector.register({ txId: 'b' });
  detector.register({ txId: 'c' });
  detector.wait({ txId: 'a', resource: 'x' });
  assert.deepEqual(detector.wait({ txId: 'b', resource: 'x' }), {
    txId: 'b', resource: 'x', granted: false, waitingFor: 'a',
  });
  detector.wait({ txId: 'c', resource: 'x' });
  assert.deepEqual(detector.snapshot().resources, [{ resource: 'x', holder: 'a', waiters: ['b', 'c'] }]);
});

test('release 把资源交给最早排队的那一个', () => {
  const { detector } = harness();
  detector.register({ txId: 'a' });
  detector.register({ txId: 'b' });
  detector.register({ txId: 'c' });
  detector.wait({ txId: 'a', resource: 'x' });
  detector.wait({ txId: 'b', resource: 'x' });
  detector.wait({ txId: 'c', resource: 'x' });
  assert.deepEqual(detector.release({ txId: 'a', resource: 'x' }), {
    txId: 'a', resource: 'x', released: true, grantedTo: 'b',
  });
  assert.deepEqual(detector.snapshot().transactions.find((one) => one.txId === 'b'), {
    txId: 'b', startedAt: 0, holds: ['x'], waitingFor: null, resource: null, aborted: false,
  });
  assert.deepEqual(detector.snapshot().resources, [{ resource: 'x', holder: 'b', waiters: ['c'] }]);
});

test('没人排队时 release 之后资源就空着', () => {
  const { detector } = harness();
  detector.register({ txId: 'a' });
  detector.wait({ txId: 'a', resource: 'x' });
  assert.equal(detector.release({ txId: 'a', resource: 'x' }).grantedTo, null);
  assert.deepEqual(detector.snapshot().resources, [{ resource: 'x', holder: null, waiters: [] }]);
});

test('一个事务同时只能等一个资源', () => {
  const { detector } = harness();
  detector.register({ txId: 'a' });
  detector.register({ txId: 'b' });
  detector.wait({ txId: 'a', resource: 'x' });
  detector.wait({ txId: 'b', resource: 'x' });
  expectError(() => detector.wait({ txId: 'b', resource: 'y' }), 'ERR_ALREADY_WAITING');
  expectError(() => detector.wait({ txId: 'a', resource: 'x' }), 'ERR_ALREADY_HOLDER');
});

test('释放自己没持有的资源、操作没见过的事务都报错', () => {
  const { detector } = harness();
  detector.register({ txId: 'a' });
  detector.register({ txId: 'b' });
  detector.wait({ txId: 'a', resource: 'x' });
  expectError(() => detector.release({ txId: 'b', resource: 'x' }), 'ERR_NOT_HOLDER');
  expectError(() => detector.release({ txId: 'a', resource: 'zzz' }), 'ERR_UNKNOWN_RESOURCE');
  expectError(() => detector.wait({ txId: 'zzz', resource: 'x' }), 'ERR_UNKNOWN_TX');
  expectError(() => detector.register({ txId: 'a' }), 'ERR_DUPLICATE_TX');
});
