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

function harness() {
  const state = { now: 1000 };
  const coordinator = createCoordinator({
    clock: () => state.now,
    participants: ['p1', 'p2', 'p3'],
    prepareTimeoutMs: 5000,
    retryBackoffMs: 1000,
  });
  return { coordinator, state };
}

const cards = (messages) => messages.map((one) => `${one.to}:${one.type}`);

test('崩之前还没决定的事务，恢复后一律回滚', () => {
  const { coordinator } = harness();
  coordinator.begin({ id: 't1' });
  coordinator.outbox();
  coordinator.receive({ from: 'p1', txnId: 't1', type: 'vote', vote: 'yes' });
  assert.equal(coordinator.log().length, 2);

  coordinator.crash();
  assert.equal(coordinator.stats().begun, 0, '内存里的计数没了');
  assert.equal(coordinator.log().length, 2, '日志是持久的');
  expectError(() => coordinator.begin({ id: 't2' }), 'ERR_BAD_STATE');
  expectError(() => coordinator.tick(), 'ERR_BAD_STATE');

  assert.equal(coordinator.recover(), 1);
  const status = coordinator.status('t1');
  assert.equal(status.decision, 'abort');
  assert.equal(status.reason, 'RECOVERED');
  assert.deepEqual(status.votes, { p1: 'yes' }, '恢复时日志里的投票还能看到');
  assert.deepEqual(cards(coordinator.outbox()), ['p1:abort', 'p2:abort', 'p3:abort']);
  assert.deepEqual(coordinator.stats(), {
    begun: 1, committed: 0, aborted: 1, acks: 0, duplicates: 0, resends: 0, recovered: 1,
  });
});

test('决定过提交的事务，恢复后不会变卦，只补发没 ack 的', () => {
  const { coordinator } = harness();
  coordinator.begin({ id: 't1' });
  coordinator.outbox();
  coordinator.receive({ from: 'p1', txnId: 't1', type: 'vote', vote: 'yes' });
  coordinator.receive({ from: 'p2', txnId: 't1', type: 'vote', vote: 'yes' });
  coordinator.receive({ from: 'p3', txnId: 't1', type: 'vote', vote: 'yes' });
  coordinator.outbox();
  coordinator.receive({ from: 'p1', txnId: 't1', type: 'ack' });

  coordinator.crash();
  assert.equal(coordinator.recover(), 1);
  const status = coordinator.status('t1');
  assert.equal(status.decision, 'commit');
  assert.equal(status.state, 'committing');
  assert.deepEqual(status.acked, ['p1']);
  assert.deepEqual(cards(coordinator.outbox()), ['p2:commit', 'p3:commit']);
  assert.equal(coordinator.stats().committed, 1, '提交次数按日志重建');
  assert.equal(coordinator.stats().acks, 1);

  coordinator.receive({ from: 'p2', txnId: 't1', type: 'ack' });
  coordinator.receive({ from: 'p3', txnId: 't1', type: 'ack' });
  assert.equal(coordinator.status('t1').state, 'done');
});

test('已经做完的事务恢复后就别再发了', () => {
  const { coordinator } = harness();
  coordinator.begin({ id: 't1' });
  coordinator.outbox();
  coordinator.receive({ from: 'p1', txnId: 't1', type: 'vote', vote: 'yes' });
  coordinator.receive({ from: 'p2', txnId: 't1', type: 'vote', vote: 'yes' });
  coordinator.receive({ from: 'p3', txnId: 't1', type: 'vote', vote: 'yes' });
  coordinator.outbox();
  for (const who of ['p1', 'p2', 'p3']) coordinator.receive({ from: who, txnId: 't1', type: 'ack' });
  assert.equal(coordinator.status('t1').state, 'done');

  coordinator.crash();
  assert.equal(coordinator.recover(), 0, '没有需要接手的事务');
  assert.equal(coordinator.status('t1').state, 'done');
  assert.deepEqual(coordinator.outbox(), []);
  assert.deepEqual(coordinator.stats(), {
    begun: 1, committed: 1, aborted: 0, acks: 3, duplicates: 0, resends: 0, recovered: 1,
  });
});

test('恢复之后用过的 id 还是用过的，恢复也是幂等的', () => {
  const { coordinator } = harness();
  coordinator.begin({ id: 't1' });
  coordinator.outbox();
  coordinator.receive({ from: 'p1', txnId: 't1', type: 'vote', vote: 'yes' });
  coordinator.receive({ from: 'p2', txnId: 't1', type: 'vote', vote: 'yes' });
  coordinator.receive({ from: 'p3', txnId: 't1', type: 'vote', vote: 'yes' });
  coordinator.outbox();
  for (const who of ['p1', 'p2', 'p3']) coordinator.receive({ from: who, txnId: 't1', type: 'ack' });

  coordinator.crash();
  coordinator.recover();
  expectError(() => coordinator.begin({ id: 't1' }), 'ERR_DUPLICATE_TXN');
  assert.equal(coordinator.begin({ id: 't2' }).state, 'preparing');

  coordinator.crash();
  assert.equal(coordinator.recover(), 1, '只有 t2 还没完');
  assert.equal(coordinator.status('t2').reason, 'RECOVERED');
  assert.equal(coordinator.status('t1').state, 'done');
});

test('没崩过不能恢复，崩两次也不行', () => {
  const { coordinator } = harness();
  expectError(() => coordinator.recover(), 'ERR_BAD_STATE');
  coordinator.crash();
  expectError(() => coordinator.crash(), 'ERR_BAD_STATE');
  expectError(() => coordinator.receive({ from: 'p1', txnId: 't1', type: 'vote', vote: 'yes' }), 'ERR_BAD_STATE');
});
