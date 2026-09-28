import { createNode } from '../lib/raftlog.js';

const line = (label, value) => console.log(`  ${label} ${value}`);
const ids = ['a', 'b', 'c'];
const nodes = new Map(ids.map((id) => [id, createNode({
  id, members: ids, term: 1, leader: id === 'a',
})]));
const deliver = (messages) => {
  const out = [];
  for (const message of messages) {
    const target = nodes.get(message.to);
    if (target) {
      out.push(...target.step(message));
    }
  }
  return out;
};

console.log('raftlog demo');
const leader = nodes.get('a');
const b = nodes.get('b');
const c = nodes.get('c');

line('propose', JSON.stringify(leader.propose('写一条')));
const first = leader.broadcast();
line('broadcast', JSON.stringify(first.map((one) => ({
  to: one.to, prevIndex: one.prevIndex, prevTerm: one.prevTerm, entries: one.entries.length,
}))));

deliver([first[0]]);
line('beforeAck', String(leader.state().commitIndex));
deliver(deliver([first[0]]));
line('afterAck', String(leader.state().commitIndex));

const second = leader.broadcast();
deliver([second[1]]);
line('follower', JSON.stringify({
  id: c.state().id, leaderId: c.state().leaderId, commitIndex: c.state().commitIndex,
}));
line('entries', JSON.stringify(c.state().entries));

const conflicted = createNode({
  id: 'b',
  members: ids,
  term: 1,
  entries: [{ term: 1, command: 'x' }, { term: 1, command: 'y' }],
});
line('conflict', JSON.stringify(conflicted.step({
  type: 'append', from: 'a', to: 'b', term: 1, prevIndex: 1, prevTerm: 5,
  entries: [], leaderCommit: 0,
})));

line('snapshot', JSON.stringify(leader.snapshotNow()));
line('afterSnapshot', JSON.stringify({
  lastIndex: leader.lastIndex(), commitIndex: leader.state().commitIndex,
  snapshot: leader.state().snapshot,
}));
line('compactRetry', JSON.stringify(leader.broadcast().map((one) => ({
  to: one.to,
  type: one.type,
  prevIndex: one.prevIndex,
  entries: one.entries === undefined ? null : one.entries.length,
}))));

line('addMember', JSON.stringify(leader.propose({ config: ['a', 'b', 'c', 'd'] })));
line('members', JSON.stringify(leader.state().members));
line('toD', JSON.stringify(leader.broadcast().at(-1).to));
line('bState', JSON.stringify({ term: b.state().term, leader: b.state().leader }));
