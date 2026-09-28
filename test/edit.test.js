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

test('一个人敲字：插入和删除的 op 长什么样', () => {
  const replica = createReplica({ clientId: 'c1' });
  const op = replica.insert(0, 'hi');
  assert.deepEqual(op, {
    id: 'c1:1',
    clientId: 'c1',
    seq: 1,
    type: 'insert',
    after: null,
    chars: [{ id: 'c1:1:0', ch: 'h' }, { id: 'c1:1:1', ch: 'i' }],
  });
  assert.equal(replica.text, 'hi');

  const second = replica.insert(1, 'X');
  assert.equal(second.after, 'c1:1:0', '插在 h 后面就锚在 h 上');
  assert.equal(replica.text, 'hXi');

  const cut = replica.delete(0, 1);
  assert.deepEqual(cut, { id: 'c1:3', clientId: 'c1', seq: 3, type: 'delete', ids: ['c1:1:0'] });
  assert.equal(replica.text, 'Xi');
  assert.deepEqual(replica.stats(), {
    clientId: 'c1', local: 3, received: 0, buffered: 0, duplicates: 0, chars: 3, visible: 2,
  });
});

test('删掉中间一段之后接着改，位置按删完的文本算', () => {
  const replica = createReplica({ clientId: 'c1' });
  replica.insert(0, 'abcdef');
  replica.delete(1, 3);
  assert.equal(replica.text, 'aef');
  replica.insert(1, 'Z');
  assert.equal(replica.text, 'aZef');
  replica.delete(2, 2);
  assert.equal(replica.text, 'aZ');
  assert.equal(replica.stats().chars, 7, '墓碑还留着，只是看不见');
});

test('删掉的位置再插，插在原来那个人前面', () => {
  const replica = createReplica({ clientId: 'c1' });
  replica.insert(0, 'abc');
  replica.delete(1, 1);
  assert.equal(replica.text, 'ac');
  replica.insert(1, 'B');
  assert.equal(replica.text, 'aBc');
  replica.delete(0, 3);
  assert.equal(replica.text, '');
});

test('索引按 JS 字符串下标（UTF-16 码元）算', () => {
  const replica = createReplica({ clientId: 'c1' });
  replica.insert(0, 'a\u{1F600}b');
  assert.equal(replica.text.length, 4);
  replica.insert(2, 'X');
  assert.equal(replica.text, 'a\uD83DX\uDE00b', '插在第二个码元前面，就是把代理对劈开');
});

test('下标和参数不合法时报哪个码', () => {
  const replica = createReplica({ clientId: 'c1' });
  expectError(() => replica.insert(1, 'x'), 'ERR_BAD_OP');
  expectError(() => replica.insert(0, ''), 'ERR_BAD_OP');
  expectError(() => replica.insert(0, 5), 'ERR_BAD_OP');
  expectError(() => replica.insert(0.5, 'x'), 'ERR_BAD_OP');
  expectError(() => replica.delete(0, 1), 'ERR_BAD_OP');
  replica.insert(0, 'abc');
  expectError(() => replica.delete(1, 3), 'ERR_BAD_OP');
  expectError(() => replica.delete(0, 0), 'ERR_BAD_OP');
  expectError(() => replica.delete(0, 1.5), 'ERR_BAD_OP');
  expectError(() => replica.delete(3, 1), 'ERR_BAD_OP');

  expectError(() => createReplica(), 'ERR_BAD_CONFIG');
  expectError(() => createReplica('c1'), 'ERR_BAD_CONFIG');
  expectError(() => createReplica({}), 'ERR_BAD_CONFIG');
  expectError(() => createReplica({ clientId: '' }), 'ERR_BAD_CONFIG');
  expectError(() => createReplica({ clientId: 'c:1' }), 'ERR_BAD_CONFIG');
});
