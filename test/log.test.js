import test from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../lib/raftlog.js';
import { code } from './util.js';

test('建节点和 state 的口径', () => {
  const node = createNode({
    id: 'a',
    members: ['a', 'b'],
    term: 3,
    leader: true,
    entries: [{ term: 1, command: 'x' }, { term: 3, command: 'y' }],
  });
  assert.deepEqual(node.state(), {
    id: 'a',
    term: 3,
    leader: true,
    leaderId: null,
    commitIndex: 0,
    snapshot: { index: 0, term: 0 },
    members: ['a', 'b'],
    entries: [{ index: 1, term: 1 }, { index: 2, term: 3 }],
  });
  assert.equal(node.lastIndex(), 2);
  assert.equal(node.lastTerm(), 3);
  assert.equal(node.termAt(0), 0);
  assert.equal(node.commandAt(2), 'y');
  assert.equal(code(() => node.termAt(3)), 'ERR_LOG_MISSING');
  assert.equal(code(() => node.commandAt(0)), 'ERR_LOG_MISSING');
});

test('prevIndex / prevTerm 对不上时给的冲突下标', () => {
  const follower = createNode({
    id: 'b',
    members: ['a', 'b', 'c'],
    term: 1,
    entries: [{ term: 1, command: 'x' }, { term: 2, command: 'y' }, { term: 2, command: 'z' }],
  });
  const append = (extra) => follower.step({
    type: 'append', from: 'a', to: 'b', term: 1, entries: [], leaderCommit: 0, ...extra,
  });
  // 比自己的尾巴还长
  assert.deepEqual(append({ prevIndex: 5, prevTerm: 2 }),
    [{ type: 'appendResponse', from: 'b', to: 'a', term: 1, success: false, conflictIndex: 4 }]);
  // prevIndex 上那条的 term 是 2，自己从下标 2 起都是 2，所以从 2 重试
  assert.deepEqual(append({ prevIndex: 3, prevTerm: 9 }),
    [{ type: 'appendResponse', from: 'b', to: 'a', term: 1, success: false, conflictIndex: 2 }]);

  const compacted = createNode({
    id: 'b',
    members: ['a', 'b'],
    term: 1,
    snapshot: { index: 2, term: 1 },
    entries: [{ term: 1, command: 'z' }],
  });
  // 落在快照里
  assert.deepEqual(compacted.step({
    type: 'append', from: 'a', to: 'b', term: 1, prevIndex: 1, prevTerm: 1,
    entries: [], leaderCommit: 0,
  }), [{ type: 'appendResponse', from: 'b', to: 'a', term: 1, success: false, conflictIndex: 3 }]);
  // 正好压在快照那个下标上、term 又不一样 → 0，等于喊 leader 发快照
  assert.deepEqual(compacted.step({
    type: 'append', from: 'a', to: 'b', term: 1, prevIndex: 2, prevTerm: 5,
    entries: [], leaderCommit: 0,
  }), [{ type: 'appendResponse', from: 'b', to: 'a', term: 1, success: false, conflictIndex: 0 }]);
});

test('冲突截断：下标一样但 term 不一样，那条和后面全删掉', () => {
  const follower = createNode({
    id: 'b',
    members: ['a', 'b'],
    term: 2,
    entries: [{ term: 1, command: 'x' }, { term: 1, command: 'y' }, { term: 1, command: 'z' }],
  });
  const out = follower.step({
    type: 'append',
    from: 'a',
    to: 'b',
    term: 2,
    prevIndex: 1,
    prevTerm: 1,
    entries: [{ term: 2, command: 'p' }, { term: 2, command: 'q' }],
    leaderCommit: 0,
  });
  assert.deepEqual(out, [{
    type: 'appendResponse', from: 'b', to: 'a', term: 2, success: true, matchIndex: 3,
  }]);
  assert.deepEqual(follower.state().entries,
    [{ index: 1, term: 1 }, { index: 2, term: 2 }, { index: 3, term: 2 }]);
  assert.equal(follower.commandAt(2), 'p');
  assert.equal(follower.commandAt(3), 'q');
  assert.equal(code(() => follower.commandAt(4)), 'ERR_LOG_MISSING');
});

test('心跳不动日志，leaderCommit 只往前挪到自己的尾巴', () => {
  const follower = createNode({
    id: 'b', members: ['a', 'b'], term: 1, entries: [{ term: 1, command: 'x' }],
  });
  const out = follower.step({
    type: 'append', from: 'a', to: 'b', term: 1, prevIndex: 1, prevTerm: 1,
    entries: [], leaderCommit: 9,
  });
  assert.deepEqual(out, [{
    type: 'appendResponse', from: 'b', to: 'a', term: 1, success: true, matchIndex: 1,
  }]);
  assert.equal(follower.state().commitIndex, 1);
  assert.equal(follower.state().leaderId, 'a');
  assert.deepEqual(follower.state().entries, [{ index: 1, term: 1 }]);
});

test('任期小的拒绝，任期大的把 leader 打回 follower', () => {
  const leader = createNode({ id: 'a', members: ['a', 'b', 'c'], term: 1, leader: true });
  leader.propose('x');
  assert.deepEqual(leader.step({
    type: 'append', from: 'b', to: 'a', term: 0, prevIndex: 0, prevTerm: 0,
    entries: [], leaderCommit: 0,
  }), [{ type: 'appendResponse', from: 'a', to: 'b', term: 1, success: false, conflictIndex: 2 }]);
  assert.equal(leader.state().leader, true);
  assert.equal(leader.state().leaderId, null);
  assert.deepEqual(leader.broadcast().length, 2);

  leader.step({
    type: 'append', from: 'b', to: 'a', term: 5, prevIndex: 0, prevTerm: 0,
    entries: [], leaderCommit: 0,
  });
  assert.equal(leader.state().term, 5);
  assert.equal(leader.state().leader, false);
  assert.equal(leader.state().leaderId, 'b');
  assert.equal(code(() => leader.broadcast()), 'ERR_NOT_LEADER');
  assert.equal(code(() => leader.propose('y')), 'ERR_NOT_LEADER');
});

test('不是给自己的消息不管，参数和消息形状不对各有各的码', () => {
  const leader = createNode({ id: 'a', members: ['a', 'b'], term: 1, leader: true });
  assert.deepEqual(leader.step({
    type: 'append', from: 'b', to: 'c', term: 1, prevIndex: 0, prevTerm: 0,
    entries: [], leaderCommit: 0,
  }), []);
  assert.equal(code(() => leader.step(null)), 'ERR_BAD_MESSAGE');
  assert.equal(code(() => leader.step({ type: 'nope', from: 'b', to: 'a', term: 1 })),
    'ERR_BAD_MESSAGE');
  assert.equal(code(() => leader.step({ type: 'append', from: 'b', to: 'a', term: 1 })),
    'ERR_BAD_MESSAGE');
  assert.equal(code(() => leader.step({
    type: 'append', from: '', to: 'a', term: 1, prevIndex: 0, prevTerm: 0,
    entries: [], leaderCommit: 0,
  })), 'ERR_BAD_MESSAGE');
  assert.equal(code(() => leader.step({
    type: 'appendResponse', from: 'b', to: 'a', term: 1, success: true,
  })), 'ERR_BAD_MESSAGE');

  assert.equal(code(() => createNode({ id: 'a', members: ['b'] })), 'ERR_BAD_CONFIG');
  assert.equal(code(() => createNode({ id: 'a', members: ['a', 'a'] })), 'ERR_BAD_CONFIG');
  assert.equal(code(() => createNode({ id: 'a', members: [] })), 'ERR_BAD_CONFIG');
  assert.equal(code(() => createNode({ id: '', members: ['a'] })), 'ERR_BAD_CONFIG');
  assert.equal(code(() => createNode({ id: 'a', members: ['a'], term: -1 })), 'ERR_BAD_CONFIG');
  assert.equal(code(() => createNode({ id: 'a', members: ['a'], snapshot: { index: 1 } })),
    'ERR_BAD_CONFIG');
  assert.equal(code(() => createNode({ id: 'a', members: ['a'], entries: [{ command: 'x' }] })),
    'ERR_BAD_CONFIG');
});
