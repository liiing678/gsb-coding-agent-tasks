import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplica } from '../lib/replica.js';

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'ReplicaError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

test('把同一份文本铺到另一个副本', () => {
  const a = createReplica({ clientId: 'c1' });
  const b = createReplica({ clientId: 'c2' });
  const seed = a.insert(0, 'hello');
  assert.equal(b.receive(seed), true);
  assert.equal(b.text, 'hello');
  assert.equal(b.stats().received, 1);
  assert.equal(b.stats().local, 0);
});

test('两个人同时往同一个位置插，两边顺序得一致', () => {
  const a = createReplica({ clientId: 'c1' });
  const b = createReplica({ clientId: 'c2' });
  const fromA = a.insert(0, 'A');
  const fromB = b.insert(0, 'B');
  a.receive(fromB);
  b.receive(fromA);
  assert.equal(a.text, 'BA', '同一锚点下 seq 大的在前，seq 一样就按 clientId 倒序');
  assert.equal(b.text, 'BA');
});

test('一边删、一边插，最后收敛到同一份文本', () => {
  const a = createReplica({ clientId: 'c1' });
  const b = createReplica({ clientId: 'c2' });
  const seed = a.insert(0, 'hello');
  b.receive(seed);

  const inserted = a.insert(0, 'X');
  const removed = b.delete(0, 5);
  assert.equal(b.receive(inserted), true);
  assert.equal(b.text, 'X');
  assert.equal(a.receive(removed), true);
  assert.equal(a.text, 'X');
});

test('同一个副本的 op 乱序到达，先压着，补齐了再一起落位', () => {
  const a = createReplica({ clientId: 'c1' });
  const first = a.insert(0, 'hi');
  const second = a.insert(2, '!');
  const late = createReplica({ clientId: 'c3' });

  assert.equal(late.receive(second), false);
  assert.equal(late.text, '');
  assert.equal(late.stats().buffered, 1);
  assert.equal(late.receive(first), true);
  assert.equal(late.text, 'hi!');
  assert.equal(late.stats().buffered, 0);
  assert.equal(late.stats().received, 2);
});

test('锚在别人插的字上，就先等那个字到', () => {
  const a = createReplica({ clientId: 'c1' });
  const b = createReplica({ clientId: 'c2' });
  const seed = a.insert(0, 'ab');
  b.receive(seed);
  const fromB = b.insert(2, 'Z');
  const fromA = a.insert(2, 'Y');

  const late = createReplica({ clientId: 'c3' });
  assert.equal(late.receive(fromB), false, 'c2 的 op 锚在 c1 的字上，那个字还没到');
  assert.equal(late.stats().buffered, 1);
  assert.equal(late.receive(fromA), false, 'c1 的第二条 op 也还缺第一条');
  assert.equal(late.stats().buffered, 2);
  assert.equal(late.receive(seed), true);
  assert.equal(late.text, 'abYZ');
  assert.equal(late.stats().buffered, 0);

  b.receive(fromA);
  a.receive(fromB);
  assert.equal(a.text, 'abYZ');
  assert.equal(b.text, 'abYZ');
});

test('三个副本各改各的，怎么投递最后都一个样', () => {
  function run(order) {
    const a = createReplica({ clientId: 'c1' });
    const seed = a.insert(0, 'hello world');
    const b = createReplica({ clientId: 'c2' });
    const c = createReplica({ clientId: 'c3' });
    b.receive(seed);
    c.receive(seed);

    const ops = [
      { owner: 'c1', op: a.insert(0, '[') },
      { owner: 'c2', op: b.delete(0, 5) },
      { owner: 'c3', op: c.insert(11, '!') },
      { owner: 'c1', op: a.insert(1, 'A') },
      { owner: 'c2', op: b.insert(0, 'B') },
    ];
    const replicas = { c1: a, c2: b, c3: c };
    for (const index of order) {
      const { owner, op } = ops[index];
      for (const [id, replica] of Object.entries(replicas)) {
        if (id !== owner) replica.receive(op);
      }
    }
    return [a.text, b.text, c.text];
  }

  for (const order of [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 4, 0, 3, 2], [3, 2, 1, 0, 4]]) {
    const [fromA, fromB, fromC] = run(order);
    assert.equal(fromA, fromB, `投递顺序 ${order} 时 c1 和 c2 不一致`);
    assert.equal(fromB, fromC, `投递顺序 ${order} 时 c2 和 c3 不一致`);
  }
  assert.equal(run([0, 1, 2, 3, 4])[0], 'B[A world!');
});

test('同一个 op 投两次不会生效两次', () => {
  const a = createReplica({ clientId: 'c1' });
  const b = createReplica({ clientId: 'c2' });
  const op = a.insert(0, 'hi');
  assert.equal(b.receive(op), true);
  assert.equal(b.receive(op), false);
  assert.equal(b.text, 'hi');
  assert.equal(b.stats().duplicates, 1);
  assert.equal(b.stats().received, 1);
});

test('op 不合法时报哪个码', () => {
  const b = createReplica({ clientId: 'c2' });
  expectError(() => b.receive(null), 'ERR_BAD_OP');
  expectError(() => b.receive({ id: 'x', clientId: 'c1', seq: 0, type: 'insert', after: null, chars: [{ id: 'a', ch: 'a' }] }), 'ERR_BAD_OP');
  expectError(() => b.receive({ id: 'x', clientId: 'c2', seq: 1, type: 'insert', after: null, chars: [{ id: 'a', ch: 'a' }] }), 'ERR_BAD_OP');
  expectError(() => b.receive({ id: 'x', clientId: 'c1', seq: 1, type: 'move', after: null }), 'ERR_BAD_OP');
  expectError(() => b.receive({ id: 'x', clientId: 'c1', seq: 1, type: 'delete', ids: [] }), 'ERR_BAD_OP');
  expectError(() => b.receive({ id: 'x', clientId: 'c1', seq: 1, type: 'insert', after: null, chars: [{ id: 'a', ch: 'ab' }] }), 'ERR_BAD_OP');
  expectError(() => b.receive({ id: 'x', clientId: 'c1:c9', seq: 1, type: 'insert', after: null, chars: [{ id: 'a', ch: 'a' }] }), 'ERR_BAD_OP');
});
