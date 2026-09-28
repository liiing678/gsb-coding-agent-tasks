import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinator } from '../lib/coordinator.js';

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'TwopcError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

function harness(extra = {}) {
  const state = { now: 1000 };
  const coordinator = createCoordinator({
    clock: () => state.now,
    participants: ['p1', 'p2', 'p3'],
    prepareTimeoutMs: 5000,
    retryBackoffMs: 1000,
    ...extra,
  });
  return { coordinator, state };
}

const cards = (messages) => messages.map((one) => `${one.to}:${one.type}`);

test('begin 就把 prepare 发给每个参与者', () => {
  const { coordinator } = harness();
  assert.deepEqual(coordinator.begin({ id: 't1', ops: [{ k: 'a' }] }), {
    id: 't1', state: 'preparing', decision: null, deadline: 6000,
  });
  assert.deepEqual(coordinator.outbox(), [
    { to: 'p1', txnId: 't1', type: 'prepare', ops: [{ k: 'a' }], attempt: 1 },
    { to: 'p2', txnId: 't1', type: 'prepare', ops: [{ k: 'a' }], attempt: 1 },
    { to: 'p3', txnId: 't1', type: 'prepare', ops: [{ k: 'a' }], attempt: 1 },
  ]);
  assert.deepEqual(coordinator.pending().map((one) => one.id), ['t1']);
  assert.deepEqual(coordinator.log().map((one) => one.type), ['BEGIN']);
});

test('全都投 yes 才提交，ack 收齐才算完', () => {
  const { coordinator } = harness();
  coordinator.begin({ id: 't1' });
  coordinator.outbox();
  assert.equal(coordinator.receive({ from: 'p1', txnId: 't1', type: 'vote', vote: 'yes' }), true);
  assert.equal(coordinator.receive({ from: 'p2', txnId: 't1', type: 'vote', vote: 'yes' }), true);
  assert.equal(coordinator.status('t1').state, 'preparing', '还差一个人就不能拍板');

  coordinator.receive({ from: 'p3', txnId: 't1', type: 'vote', vote: 'yes' });
  assert.equal(coordinator.status('t1').decision, 'commit');
  assert.equal(coordinator.status('t1').state, 'committing');
  assert.deepEqual(cards(coordinator.outbox()), ['p1:commit', 'p2:commit', 'p3:commit']);

  coordinator.receive({ from: 'p1', txnId: 't1', type: 'ack' });
  coordinator.receive({ from: 'p2', txnId: 't1', type: 'ack' });
  assert.equal(coordinator.status('t1').state, 'committing');
  coordinator.receive({ from: 'p3', txnId: 't1', type: 'ack' });
  assert.equal(coordinator.status('t1').state, 'done');
  assert.deepEqual(coordinator.pending(), []);
  assert.deepEqual(coordinator.stats(), {
    begun: 1, committed: 1, aborted: 0, acks: 3, duplicates: 0, resends: 0, recovered: 0,
  });
});

test('有人投 no 就立刻回滚，不等剩下的人', () => {
  const { coordinator } = harness();
  coordinator.begin({ id: 't1' });
  coordinator.outbox();
  coordinator.receive({ from: 'p1', txnId: 't1', type: 'vote', vote: 'yes' });
  coordinator.receive({ from: 'p2', txnId: 't1', type: 'vote', vote: 'no' });
  const status = coordinator.status('t1');
  assert.equal(status.decision, 'abort');
  assert.equal(status.reason, 'VOTE_NO');
  assert.deepEqual(status.votes, { p1: 'yes', p2: 'no' });
  assert.deepEqual(cards(coordinator.outbox()), ['p1:abort', 'p2:abort', 'p3:abort']);
});

test('投票没投齐，超时就回滚', () => {
  const { coordinator, state } = harness();
  coordinator.begin({ id: 't1' });
  coordinator.outbox();
  state.now += 4999;
  assert.deepEqual(coordinator.tick(), []);
  assert.equal(coordinator.status('t1').decision, null);

  state.now += 1;
  assert.deepEqual(coordinator.tick(), [{ type: 'abort', txnId: 't1', reason: 'PREPARE_TIMEOUT' }]);
  assert.deepEqual(coordinator.status('t1').reason, 'PREPARE_TIMEOUT');
  assert.equal(coordinator.stats().aborted, 1);
});

test('决定之后只给没 ack 的人重发，退避时间没到就不发', () => {
  const { coordinator, state } = harness();
  coordinator.begin({ id: 't1' });
  coordinator.outbox();
  coordinator.receive({ from: 'p1', txnId: 't1', type: 'vote', vote: 'yes' });
  coordinator.receive({ from: 'p2', txnId: 't1', type: 'vote', vote: 'yes' });
  coordinator.receive({ from: 'p3', txnId: 't1', type: 'vote', vote: 'yes' });
  coordinator.outbox();
  coordinator.receive({ from: 'p1', txnId: 't1', type: 'ack' });

  state.now += 999;
  assert.deepEqual(coordinator.tick(), []);
  state.now += 1;
  assert.deepEqual(coordinator.tick(), [
    { type: 'resend', txnId: 't1', decision: 'commit', to: ['p2', 'p3'] },
  ]);
  assert.deepEqual(cards(coordinator.outbox()), ['p2:commit', 'p3:commit']);
  assert.equal(coordinator.stats().resends, 2);
  assert.deepEqual(coordinator.tick(), [], '刚发过就不再发');
});

test('重复的投票和 ack 只是重复，不改状态', () => {
  const { coordinator } = harness();
  coordinator.begin({ id: 't1' });
  coordinator.outbox();
  assert.equal(coordinator.receive({ from: 'p1', txnId: 't1', type: 'vote', vote: 'yes' }), true);
  assert.equal(coordinator.receive({ from: 'p1', txnId: 't1', type: 'vote', vote: 'no' }), false);
  assert.equal(coordinator.status('t1').votes.p1, 'yes');
  assert.equal(coordinator.stats().duplicates, 1);

  coordinator.receive({ from: 'p2', txnId: 't1', type: 'vote', vote: 'yes' });
  coordinator.receive({ from: 'p3', txnId: 't1', type: 'vote', vote: 'yes' });
  coordinator.outbox();
  coordinator.receive({ from: 'p1', txnId: 't1', type: 'ack' });
  coordinator.receive({ from: 'p1', txnId: 't1', type: 'ack' });
  assert.equal(coordinator.stats().duplicates, 2);
  assert.equal(coordinator.stats().acks, 1);
});

test('参数和消息不合法时报哪个码', () => {
  const { coordinator } = harness();
  coordinator.begin({ id: 't1' });
  coordinator.outbox();
  expectError(() => coordinator.receive(null), 'ERR_BAD_MESSAGE');
  expectError(() => coordinator.receive({ from: 'p9', txnId: 't1', type: 'vote', vote: 'yes' }), 'ERR_UNKNOWN_PARTICIPANT');
  expectError(() => coordinator.receive({ from: 'p1', txnId: 'nope', type: 'vote', vote: 'yes' }), 'ERR_UNKNOWN_TXN');
  expectError(() => coordinator.receive({ from: 'p1', txnId: 't1', type: 'vote', vote: 'maybe' }), 'ERR_BAD_MESSAGE');
  expectError(() => coordinator.receive({ from: 'p1', txnId: 't1', type: 'ping' }), 'ERR_BAD_MESSAGE');
  expectError(() => coordinator.receive({ from: 'p1', txnId: 't1', type: 'ack' }), 'ERR_BAD_MESSAGE');
  expectError(() => coordinator.begin({ id: '' }), 'ERR_BAD_TXN');
  expectError(() => coordinator.begin({ id: 't2', ops: 'nope' }), 'ERR_BAD_TXN');
  expectError(() => coordinator.begin({ id: 't1' }), 'ERR_DUPLICATE_TXN');
  expectError(() => coordinator.status('nope'), 'ERR_UNKNOWN_TXN');
  expectError(() => createCoordinator(null), 'ERR_BAD_CONFIG');
  expectError(() => createCoordinator({ participants: [] }), 'ERR_BAD_CONFIG');
  expectError(() => createCoordinator({ participants: ['a', 'a'] }), 'ERR_BAD_CONFIG');
  expectError(() => createCoordinator({ participants: ['a'], clock: 1 }), 'ERR_BAD_CONFIG');
  expectError(() => createCoordinator({ participants: ['a'], prepareTimeoutMs: 0 }), 'ERR_BAD_CONFIG');
  expectError(() => createCoordinator({ participants: ['a'], retryBackoffMs: 1.5 }), 'ERR_BAD_CONFIG');
});
