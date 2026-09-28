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

/** a 持 x，b 持 y，然后 a 等 y、b 等 x —— 一个两节点的环。 */
function twoCycle(startedAt = {}) {
  const h = harness();
  h.detector.register({ txId: 'a', startedAt: startedAt.a ?? 0 });
  h.detector.register({ txId: 'b', startedAt: startedAt.b ?? 10 });
  h.detector.wait({ txId: 'a', resource: 'x' });
  h.detector.wait({ txId: 'b', resource: 'y' });
  h.detector.wait({ txId: 'a', resource: 'y' });
  h.detector.wait({ txId: 'b', resource: 'x' });
  return h;
}

test('没环的时候 detect 什么都不动', () => {
  const { detector } = harness();
  detector.register({ txId: 'a' });
  detector.register({ txId: 'b' });
  detector.wait({ txId: 'a', resource: 'x' });
  detector.wait({ txId: 'b', resource: 'x' });
  assert.deepEqual(detector.detect(), { cycles: [], victims: [], timeouts: [] });
  assert.equal(detector.snapshot().resources[0].holder, 'a');
});

test('互相等待会被认成环，最年轻的那个被 abort', () => {
  const { detector } = twoCycle({ a: 0, b: 10 });
  assert.deepEqual(detector.detect(), { cycles: [['a', 'b']], victims: ['b'], timeouts: [] });
  assert.equal(detector.snapshot().transactions.find((one) => one.txId === 'b').aborted, true);
  // b 让出 y，排队的 a 拿到 y，环就断了
  assert.deepEqual(detector.snapshot().resources, [
    { resource: 'x', holder: 'a', waiters: [] },
    { resource: 'y', holder: 'a', waiters: [] },
  ]);
  assert.equal(detector.stats().aborts, 1);
});

test('开始时刻相同的环，abort txId 大的那个', () => {
  const { detector } = twoCycle({ a: 5, b: 5 });
  assert.deepEqual(detector.detect().victims, ['b']);
});

test('环的报告从字典序最小的 txId 开始，多个环按首元素排序', () => {
  const { detector } = harness();
  for (const id of ['c', 'd', 'a', 'b']) detector.register({ txId: id, startedAt: 0 });
  detector.wait({ txId: 'c', resource: 'p' });
  detector.wait({ txId: 'd', resource: 'q' });
  detector.wait({ txId: 'c', resource: 'q' });
  detector.wait({ txId: 'd', resource: 'p' });
  detector.wait({ txId: 'a', resource: 'm' });
  detector.wait({ txId: 'b', resource: 'n' });
  detector.wait({ txId: 'a', resource: 'n' });
  detector.wait({ txId: 'b', resource: 'm' });
  assert.deepEqual(detector.detect().cycles, [['a', 'b'], ['c', 'd']]);
  assert.equal(detector.stats().cycles, 2);
});

test('等太久算超时，超时先处理，处理完环就没了', () => {
  const { detector, set } = harness();
  detector.register({ txId: 'a', startedAt: 0 });
  detector.register({ txId: 'b', startedAt: 10 });
  detector.wait({ txId: 'a', resource: 'x' });
  detector.wait({ txId: 'b', resource: 'y' });
  detector.wait({ txId: 'a', resource: 'y', timeoutMs: 500 });   // a 等得久，先轮不到它
  detector.wait({ txId: 'b', resource: 'x' });          // b 等 a，waitedAt = 0
  set(101);
  const report = detector.detect();
  assert.deepEqual(report.timeouts, ['b']);
  assert.deepEqual(report.cycles, []);
  assert.deepEqual(report.victims, ['b']);
  assert.equal(detector.stats().aborts, 1);
  assert.equal(detector.stats().timeouts, 1);
});

test('wait 可以自己指定更长的等待额度', () => {
  const { detector, set } = harness();
  detector.register({ txId: 'a' });
  detector.register({ txId: 'b' });
  detector.wait({ txId: 'a', resource: 'x' });
  detector.wait({ txId: 'b', resource: 'x', timeoutMs: 500 });
  set(200);
  assert.deepEqual(detector.detect(), { cycles: [], victims: [], timeouts: [] });
  set(501);
  assert.deepEqual(detector.detect().timeouts, ['b']);
});

test('被 abort 的事务再动就报 ERR_TX_ABORTED', () => {
  const { detector } = twoCycle();
  detector.detect();
  expectError(() => detector.wait({ txId: 'b', resource: 'z' }), 'ERR_TX_ABORTED');
  expectError(() => detector.release({ txId: 'b', resource: 'y' }), 'ERR_TX_ABORTED');
  assert.equal(detector.stats().transactions, 2);
});

test('abort 掉的事务持有的资源按 FIFO 交给下一个', () => {
  const { detector } = harness();
  detector.register({ txId: 'a', startedAt: 0 });
  detector.register({ txId: 'b', startedAt: 10 });
  detector.register({ txId: 'c', startedAt: 20 });
  detector.wait({ txId: 'b', resource: 'y' });
  detector.wait({ txId: 'c', resource: 'y' });          // 排队
  detector.wait({ txId: 'a', resource: 'x' });
  detector.wait({ txId: 'b', resource: 'x' });          // b 等 a 的 x
  detector.wait({ txId: 'a', resource: 'y' });          // a 等 b 的 y → 环 a→b→a
  assert.deepEqual(detector.detect(), { cycles: [['a', 'b']], victims: ['b'], timeouts: [] });
  assert.deepEqual(detector.snapshot().resources, [
    { resource: 'x', holder: 'a', waiters: [] },
    { resource: 'y', holder: 'c', waiters: ['a'] },
  ]);
});

test('参数不合法时各报哪个码', () => {
  const { detector } = harness();
  expectError(() => detector.register({ txId: '' }), 'ERR_BAD_ARGS');
  expectError(() => detector.register({ txId: 'a', startedAt: 'now' }), 'ERR_BAD_ARGS');
  detector.register({ txId: 'a' });
  expectError(() => detector.wait({ txId: 'a', resource: '' }), 'ERR_BAD_ARGS');
  expectError(() => detector.wait({ txId: 'a', resource: 'x', timeoutMs: 0 }), 'ERR_BAD_ARGS');
  expectError(() => createDeadlockDetector(null), 'ERR_BAD_CONFIG');
  expectError(() => createDeadlockDetector({ clock: 1 }), 'ERR_BAD_CONFIG');
  expectError(() => createDeadlockDetector({ maxWaitMs: 0 }), 'ERR_BAD_CONFIG');
});

test('统计口径', () => {
  const { detector, set } = harness();
  detector.register({ txId: 'a' });
  detector.register({ txId: 'b' });
  detector.register({ txId: 'c' });
  detector.wait({ txId: 'a', resource: 'x' });
  detector.wait({ txId: 'b', resource: 'x' });
  detector.wait({ txId: 'c', resource: 'x' });
  set(101);
  detector.detect();
  detector.release({ txId: 'a', resource: 'x' });
  assert.deepEqual(detector.stats(), {
    transactions: 3,
    held: 0,
    waiting: 0,
    grants: 1,
    releases: 1,
    cycles: 0,
    aborts: 2,
    timeouts: 2,
  });
});
