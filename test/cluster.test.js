import test from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../lib/raftlog.js';
import { cluster, code } from './util.js';

test('多数派到齐才提交，leaderCommit 跟着下发', () => {
  const { nodes, deliver } = cluster();
  const leader = nodes.get('a');
  const b = nodes.get('b');
  const c = nodes.get('c');

  assert.deepEqual(leader.propose('写一条'), { index: 1, term: 1 });
  assert.equal(leader.state().commitIndex, 0);

  const first = leader.broadcast();
  assert.equal(first.length, 2);
  assert.equal(first[0].to, 'b');
  assert.equal(first[0].prevIndex, 0);
  assert.equal(first[0].prevTerm, 0);
  assert.deepEqual(first[0].entries, [{ term: 1, command: '写一条' }]);
  assert.equal(first[0].leaderCommit, 0);

  deliver([first[0]]);
  assert.equal(leader.state().commitIndex, 0);
  deliver(deliver([first[0]]));
  assert.equal(leader.state().commitIndex, 1);
  assert.equal(b.commandAt(1), '写一条');

  const second = leader.broadcast();
  assert.equal(second[0].leaderCommit, 1);
  deliver([second[1]]);
  assert.equal(c.commandAt(1), '写一条');
  assert.equal(c.state().commitIndex, 1);
  assert.equal(c.state().leaderId, 'a');
});

test('只能提交当前任期的条目，老任期的那条跟着一起走', () => {
  const leader = createNode({
    id: 'a',
    members: ['a', 'b', 'c'],
    term: 2,
    leader: true,
    entries: [{ term: 1, command: 'old' }],
  });
  leader.step({ type: 'appendResponse', from: 'b', to: 'a', term: 2, success: true, matchIndex: 1 });
  assert.equal(leader.state().commitIndex, 0);

  assert.deepEqual(leader.propose('new'), { index: 2, term: 2 });
  assert.equal(leader.state().commitIndex, 0);
  leader.step({ type: 'appendResponse', from: 'b', to: 'a', term: 2, success: true, matchIndex: 2 });
  assert.equal(leader.state().commitIndex, 2);
});

test('失败响应把 nextIndex 退回去，退到快照前面就改发快照', () => {
  const { nodes } = cluster();
  const leader = nodes.get('a');
  leader.propose('x');
  assert.equal(leader.broadcast()[0].prevIndex, 0);

  leader.step({ type: 'appendResponse', from: 'b', to: 'a', term: 1, success: false, conflictIndex: 2 });
  const retry = leader.broadcast()[0];
  assert.equal(retry.type, 'append');
  assert.equal(retry.prevIndex, 1);
  assert.deepEqual(retry.entries, []);

  const compacted = createNode({
    id: 'a',
    members: ['a', 'b'],
    term: 3,
    leader: true,
    snapshot: { index: 2, term: 2 },
    entries: [{ term: 3, command: 'x' }],
  });
  assert.equal(compacted.broadcast()[0].type, 'append');
  compacted.step({
    type: 'appendResponse', from: 'b', to: 'a', term: 3, success: false, conflictIndex: 1,
  });
  const snap = compacted.broadcast()[0];
  assert.equal(snap.type, 'snapshot');
  assert.equal(snap.lastIncludedIndex, 2);
  assert.equal(snap.lastIncludedTerm, 2);
  assert.deepEqual(snap.members, ['a', 'b']);

  compacted.step({
    type: 'snapshotResponse', from: 'b', to: 'a', term: 3, success: true, matchIndex: 2,
  });
  const back = compacted.broadcast()[0];
  assert.equal(back.type, 'append');
  assert.equal(back.prevIndex, 2);
  assert.deepEqual(back.entries, [{ term: 3, command: 'x' }]);
});

test('snapshotNow 之后 lastIndex / termAt / commandAt 的口径', () => {
  const { nodes, deliver } = cluster();
  const leader = nodes.get('a');
  leader.propose('x');
  deliver(deliver([leader.broadcast()[0]]));
  assert.equal(leader.state().commitIndex, 1);

  assert.deepEqual(leader.snapshotNow(), { index: 1, term: 1 });
  assert.deepEqual(leader.state().snapshot, { index: 1, term: 1 });
  assert.deepEqual(leader.state().entries, []);
  assert.equal(leader.lastIndex(), 1);
  assert.equal(leader.termAt(1), 1);
  assert.equal(code(() => leader.commandAt(1)), 'ERR_LOG_MISSING');
  assert.equal(code(() => leader.termAt(0)), 'ERR_LOG_MISSING');
  // 什么都没提交的时候什么都不做
  const fresh = createNode({ id: 'b', members: ['a', 'b'] });
  assert.deepEqual(fresh.snapshotNow(), { index: 0, term: 0 });
});

test('InstallSnapshot：term 对得上就留尾巴，对不上就全清', () => {
  const kept = createNode({
    id: 'b',
    members: ['a', 'b'],
    term: 3,
    entries: [{ term: 1, command: 'x' }, { term: 2, command: 'y' }, { term: 2, command: 'z' }],
  });
  const keptOut = kept.step({
    type: 'snapshot', from: 'a', to: 'b', term: 3, lastIncludedIndex: 2, lastIncludedTerm: 2,
  });
  assert.deepEqual(keptOut, [{
    type: 'snapshotResponse', from: 'b', to: 'a', term: 3, success: true, matchIndex: 2,
  }]);
  assert.deepEqual(kept.state().snapshot, { index: 2, term: 2 });
  assert.deepEqual(kept.state().entries, [{ index: 3, term: 2 }]);
  assert.equal(kept.state().commitIndex, 2);
  assert.equal(kept.commandAt(3), 'z');

  const wiped = createNode({
    id: 'b',
    members: ['a', 'b'],
    term: 3,
    entries: [{ term: 1, command: 'x' }, { term: 2, command: 'y' }],
  });
  wiped.step({
    type: 'snapshot', from: 'a', to: 'b', term: 3, lastIncludedIndex: 2, lastIncludedTerm: 5,
  });
  assert.deepEqual(wiped.state().entries, []);
  assert.deepEqual(wiped.state().snapshot, { index: 2, term: 5 });
  assert.equal(wiped.lastIndex(), 2);

  const grown = createNode({ id: 'b', members: ['a', 'b'], term: 3 });
  grown.step({
    type: 'snapshot',
    from: 'a',
    to: 'b',
    term: 3,
    lastIncludedIndex: 4,
    lastIncludedTerm: 3,
    members: ['a', 'b', 'c'],
  });
  assert.deepEqual(grown.state().members, ['a', 'b', 'c']);
  assert.equal(grown.state().commitIndex, 4);
});

test('成员变更：leader 立刻生效，follower 等提交', () => {
  const { nodes, deliver } = cluster();
  const leader = nodes.get('a');
  const b = nodes.get('b');

  leader.propose({ config: ['a', 'b'] });
  assert.deepEqual(leader.state().members, ['a', 'b']);
  const messages = leader.broadcast();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, 'b');

  deliver([messages[0]]);
  // 配置条目进了 b 的日志，但还没提交，成员表先不动
  assert.deepEqual(b.state().members, ['a', 'b', 'c']);
  assert.equal(b.state().commitIndex, 0);
  deliver(deliver([messages[0]]));
  assert.equal(leader.state().commitIndex, 1);
  // leader 下一次广播把 leaderCommit 带过去，b 提交之后才换成员表
  const after = leader.broadcast();
  assert.equal(after[0].leaderCommit, 1);
  deliver([after[0]]);
  assert.equal(b.state().commitIndex, 1);
  assert.deepEqual(b.state().members, ['a', 'b']);

  // follower 那边：配置条目进日志但还没提交时，成员表不动
  const follower = createNode({
    id: 'b', members: ['a', 'b'], term: 1, entries: [{ term: 1, command: 'x' }],
  });
  follower.step({
    type: 'append',
    from: 'a',
    to: 'b',
    term: 1,
    prevIndex: 1,
    prevTerm: 1,
    entries: [{ term: 1, command: { config: ['a', 'b', 'd'] } }],
    leaderCommit: 1,
  });
  assert.deepEqual(follower.state().members, ['a', 'b']);
  follower.step({
    type: 'append', from: 'a', to: 'b', term: 1, prevIndex: 2, prevTerm: 1,
    entries: [], leaderCommit: 2,
  });
  assert.deepEqual(follower.state().members, ['a', 'b', 'd']);
  assert.equal(follower.state().commitIndex, 2);

  assert.equal(code(() => leader.propose({ config: ['b', 'c'] })), 'ERR_BAD_CONFIG');
  assert.equal(code(() => leader.propose({ config: ['a', 'c'] })), 'ERR_BAD_CONFIG');
  assert.equal(code(() => leader.propose({ config: ['a'] })), null);
  assert.deepEqual(leader.state().members, ['a']);
});
