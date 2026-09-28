import test from 'node:test';
import assert from 'node:assert/strict';

import { compare, dots, missing } from '../lib/vclock.js';
import { code, node, texts } from './util.js';

test('createNode 与 send', () => {
  const a = node('a');
  assert.equal(a.id, 'a');
  assert.deepEqual(a.clock(), []);
  assert.deepEqual(a.pending(), []);

  const m1 = a.send('a1');
  assert.deepEqual(m1, { from: 'a', payload: 'a1', clock: [{ id: 'a', from: 1, to: 1 }] });
  const m2 = a.send({ n: 2 });
  assert.deepEqual(m2.clock, [{ id: 'a', from: 1, to: 2 }]);
  assert.deepEqual(m2.payload, { n: 2 });
  assert.deepEqual(a.clock(), [{ id: 'a', from: 1, to: 2 }]);
  // 拿到的时钟是副本，改它不影响节点
  m2.clock.push({ id: 'z', from: 1, to: 1 });
  assert.deepEqual(a.clock(), [{ id: 'a', from: 1, to: 2 }]);

  assert.equal(code(() => node('')), 'ERR_BAD_CLOCK');
  assert.equal(code(() => node(7)), 'ERR_BAD_CLOCK');
  assert.equal(code(() => node()), 'ERR_BAD_CLOCK');
});

test('send 只动自己那一段，别人的点原样带着走', () => {
  const a = node('a');
  const b = node('b');
  b.deliver(a.send('a1'));
  const m2 = b.send('b1');
  assert.deepEqual(m2.clock, [{ id: 'a', from: 1, to: 1 }, { id: 'b', from: 1, to: 1 }]);
  const m3 = b.send('b2');
  assert.deepEqual(texts(dots(m3.clock)), ['a:1', 'b:1', 'b:2']);
  assert.equal(compare(a.clock(), m3.clock), 'before');
  assert.equal(compare(b.clock(), m3.clock), 'equal');
});

test('乱序到达：先挂起，前置到齐再一起并进时钟', () => {
  const a = node('a');
  const m1 = a.send('a1');
  const m2 = a.send('a2');

  const b = node('b');
  assert.equal(b.deliver(m2), false);
  assert.deepEqual(b.pending().map((held) => held.payload), ['a2']);
  assert.deepEqual(b.clock(), []);

  assert.equal(b.deliver(m1), true);
  assert.deepEqual(b.clock(), [{ id: 'a', from: 1, to: 2 }]);
  assert.deepEqual(b.pending(), []);
  assert.equal(compare(b.clock(), a.clock()), 'equal');
});

test('重复投递返回 false，挂起里的重复也不重复入队', () => {
  const a = node('a');
  const m1 = a.send('a1');
  const m2 = a.send('a2');

  const b = node('b');
  assert.equal(b.deliver(m2), false);
  assert.equal(b.deliver(m2), false);
  assert.equal(b.pending().length, 1);

  assert.equal(b.deliver(m1), true);
  assert.equal(b.deliver(m1), false);
  assert.equal(b.deliver(m2), false);
  assert.deepEqual(b.clock(), [{ id: 'a', from: 1, to: 2 }]);
  assert.deepEqual(b.pending(), []);
});

test('一条消息到齐能把挂起的整串都带进来', () => {
  const a = node('a');
  const m1 = a.send('a1');
  const m2 = a.send('a2');
  const c = node('c');
  c.deliver(m1);
  c.deliver(m2);
  const m3 = c.send('c1');

  const b = node('b');
  assert.equal(b.deliver(m3), false);
  assert.equal(b.deliver(m2), false);
  assert.deepEqual(b.pending().length, 2);
  assert.deepEqual(b.clock(), []);

  assert.equal(b.deliver(m1), true);
  assert.deepEqual(b.pending(), []);
  assert.deepEqual(texts(dots(b.clock())), ['a:1', 'a:2', 'c:1']);
  assert.equal(compare(b.clock(), c.clock()), 'equal');
});

test('双向互发：并发到追上，消息形状不对抛 ERR_BAD_MESSAGE', () => {
  const a = node('a');
  const b = node('b');
  const fromA = a.send('from-a');
  const fromB = b.send('from-b');
  assert.equal(compare(a.clock(), b.clock()), 'concurrent');

  assert.equal(b.deliver(fromA), true);
  assert.equal(a.deliver(fromB), true);
  assert.equal(compare(a.clock(), b.clock()), 'equal');
  assert.deepEqual(texts(dots(a.clock())), ['a:1', 'b:1']);

  const fromA2 = a.send('from-a-2');
  assert.deepEqual(missing(b.clock(), fromA2.clock), ['a:2']);
  assert.equal(b.deliver(fromA2), true);
  assert.equal(compare(b.clock(), a.clock()), 'equal');
  assert.deepEqual(missing(a.clock(), b.clock()), []);

  const ok = a.send('a3');
  assert.equal(code(() => b.deliver(null)), 'ERR_BAD_MESSAGE');
  assert.equal(code(() => b.deliver('x')), 'ERR_BAD_MESSAGE');
  assert.equal(code(() => b.deliver([])), 'ERR_BAD_MESSAGE');
  assert.equal(code(() => b.deliver({ ...ok, from: '' })), 'ERR_BAD_MESSAGE');
  assert.equal(code(() => b.deliver({ from: 'a', clock: ok.clock })), 'ERR_BAD_MESSAGE');
  assert.equal(code(() => b.deliver({ ...ok, clock: 'nope' })), 'ERR_BAD_MESSAGE');
  assert.equal(code(() => b.deliver({ ...ok, clock: [] })), 'ERR_BAD_MESSAGE');
  assert.equal(code(() => b.deliver({ ...ok, clock: [{ id: 'c', from: 1, to: 1 }] })), 'ERR_BAD_MESSAGE');
  assert.equal(b.deliver(ok), true);
});
