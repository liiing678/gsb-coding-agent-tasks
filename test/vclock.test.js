import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compare, contains, dots, empty, merge, missing, tick,
} from '../lib/vclock.js';
import { code, texts } from './util.js';

const run = (id, from, to) => ({ id, from, to });

test('规范化形状：相邻要并、不相邻要留洞、按 id 排序', () => {
  assert.deepEqual(empty(), []);
  assert.deepEqual(tick(empty(), 'a'), [run('a', 1, 1)]);
  assert.deepEqual(tick(tick(empty(), 'a'), 'a'), [run('a', 1, 2)]);

  assert.deepEqual(merge([run('a', 1, 2)], [run('a', 3, 3)]), [run('a', 1, 3)]);
  assert.deepEqual(merge([run('a', 1, 2)], [run('a', 4, 5)]), [run('a', 1, 2), run('a', 4, 5)]);
  assert.deepEqual(merge([run('b', 1, 1)], [run('a', 1, 1)]), [run('a', 1, 1), run('b', 1, 1)]);
  assert.deepEqual(merge([run('a', 2, 3)], [run('a', 1, 4)]), [run('a', 1, 4)]);
  assert.deepEqual(merge([run('b', 1, 2)], [run('b', 5, 5)]), [run('b', 1, 2), run('b', 5, 5)]);
});

test('merge 是点的并集，不是计数相加，而且不改动传进来的时钟', () => {
  const once = tick(tick(empty(), 'a'), 'a');
  const input = [run('a', 1, 2)];
  assert.deepEqual(merge(once, once), once);
  assert.deepEqual(merge(once, once), [run('a', 1, 2)]);
  assert.deepEqual(merge(input), [run('a', 1, 2)]);
  assert.deepEqual(input, [run('a', 1, 2)]);
  assert.deepEqual(merge(), []);
  assert.deepEqual(merge(empty(), empty()), []);
  assert.deepEqual(merge([run('a', 1, 2)], [run('a', 2, 3)]), [run('a', 1, 3)]);
});

test('compare 比的是点的集合，不是顶', () => {
  const a1 = tick(empty(), 'a');
  const a2 = tick(a1, 'a');
  const b1 = tick(empty(), 'b');
  const ab = merge(a2, b1);

  assert.equal(compare(a1, a1), 'equal');
  assert.equal(compare(empty(), empty()), 'equal');
  assert.equal(compare(a1, a2), 'before');
  assert.equal(compare(a2, a1), 'after');
  assert.equal(compare(empty(), a1), 'before');
  assert.equal(compare(a1, empty()), 'after');
  assert.equal(compare(a1, b1), 'concurrent');
  assert.equal(compare(a2, ab), 'before');
  assert.equal(compare(ab, b1), 'after');
  assert.equal(compare(ab, merge(a2, b1)), 'equal');
  assert.equal(compare(merge(ab, tick(empty(), 'c')), merge(a2, tick(empty(), 'c'))), 'after');

  // 带洞的时钟：顶是 5，但 3 那个点没有，所以跟 {a:1..5} 比是 before / after，不是 equal。
  const gap = merge([run('a', 1, 2)], [run('a', 4, 5)]);
  assert.deepEqual(gap, [run('a', 1, 2), run('a', 4, 5)]);
  assert.equal(compare(gap, merge([run('a', 1, 5)])), 'before');
  assert.equal(compare(merge([run('a', 1, 5)]), gap), 'after');
  assert.equal(compare(gap, gap), 'equal');
  // 两边各有对方没有的点：顶一样也还是 concurrent。
  assert.equal(compare(merge([run('a', 1, 3)]), merge([run('a', 1, 2)], [run('a', 4, 4)])), 'concurrent');
  assert.equal(compare(merge([run('a', 1, 3)]), merge([run('a', 1, 2)])), 'after');
});

test('dots 的展开顺序，以及 contains / missing', () => {
  const clock = merge([run('a', 1, 2)], [run('b', 1, 1)]);
  assert.deepEqual(texts(dots(clock)), ['a:1', 'a:2', 'b:1']);
  assert.deepEqual(dots(empty()), []);

  assert.equal(contains(clock, { id: 'a', counter: 1 }), true);
  assert.equal(contains(clock, { id: 'a', counter: 2 }), true);
  assert.equal(contains(clock, { id: 'a', counter: 3 }), false);
  assert.equal(contains(clock, { id: 'c', counter: 1 }), false);

  const wider = tick(clock, 'b');
  assert.deepEqual(texts(dots(wider)), ['a:1', 'a:2', 'b:1', 'b:2']);
  assert.deepEqual(missing(clock, wider), ['b:2']);
  assert.deepEqual(missing(wider, clock), []);
  assert.deepEqual(missing(clock, clock), []);
  assert.deepEqual(missing(empty(), clock), ['a:1', 'a:2', 'b:1']);
  assert.deepEqual(missing(clock, empty()), []);

  // 带洞的时钟：洞里的点不算有，展开的时候也跳过。
  const gap = merge([run('a', 1, 2)], [run('a', 4, 5)]);
  assert.deepEqual(texts(dots(gap)), ['a:1', 'a:2', 'a:4', 'a:5']);
  assert.equal(contains(gap, { id: 'a', counter: 3 }), false);
  assert.equal(contains(gap, { id: 'a', counter: 5 }), true);
  assert.deepEqual(missing(gap, merge([run('a', 1, 5)])), ['a:3']);
  assert.deepEqual(missing(clock, gap), ['a:4', 'a:5']);
});

test('时钟形状不对一律 ERR_BAD_CLOCK', () => {
  assert.equal(code(() => merge(null)), 'ERR_BAD_CLOCK');
  assert.equal(code(() => merge('a:1')), 'ERR_BAD_CLOCK');
  assert.equal(code(() => merge([[1, 2]])), 'ERR_BAD_CLOCK');
  assert.equal(code(() => merge([1])), 'ERR_BAD_CLOCK');
  assert.equal(code(() => merge([{ id: '', from: 1, to: 1 }])), 'ERR_BAD_CLOCK');
  assert.equal(code(() => merge([{ id: 1, from: 1, to: 1 }])), 'ERR_BAD_CLOCK');
  assert.equal(code(() => merge([{ id: 'a', from: 0, to: 1 }])), 'ERR_BAD_CLOCK');
  assert.equal(code(() => merge([{ id: 'a', from: 1.5, to: 2 }])), 'ERR_BAD_CLOCK');
  assert.equal(code(() => merge([{ id: 'a', from: 2, to: 1 }])), 'ERR_BAD_CLOCK');
  assert.equal(code(() => merge([run('a', 1, 2), run('a', 3, 4)])), 'ERR_BAD_CLOCK');
  assert.equal(code(() => merge([run('a', 1, 1), run('a', 2, 2)])), 'ERR_BAD_CLOCK');
  assert.equal(code(() => merge([run('b', 1, 1), run('a', 1, 1)])), 'ERR_BAD_CLOCK');
  assert.equal(code(() => merge([run('a', 1, 1)], [null])), 'ERR_BAD_CLOCK');
  assert.equal(code(() => tick([run('a', 1, 2), run('a', 3, 3)], 'a')), 'ERR_BAD_CLOCK');
  assert.equal(code(() => tick(empty(), '')), 'ERR_BAD_CLOCK');
  assert.equal(code(() => tick(empty(), 3)), 'ERR_BAD_CLOCK');
  assert.equal(code(() => compare(null, empty())), 'ERR_BAD_CLOCK');
  assert.equal(code(() => compare(empty(), [run('a', 1, 1), run('a', 2, 2)])), 'ERR_BAD_CLOCK');
  assert.equal(code(() => dots('nope')), 'ERR_BAD_CLOCK');
  assert.equal(code(() => missing(empty(), [{ id: 'a', from: 2, to: 1 }])), 'ERR_BAD_CLOCK');
  // 带洞的时钟是合法形状，别顺手把它修好或者当错误
  assert.deepEqual(merge([run('a', 1, 2), run('a', 4, 5)]), [run('a', 1, 2), run('a', 4, 5)]);
  assert.deepEqual(tick([run('a', 1, 2), run('a', 4, 5)], 'a'), [run('a', 1, 2), run('a', 4, 6)]);
});

test('dot 形状不对一律 ERR_BAD_DOT，值对不上是 false', () => {
  const clock = tick(empty(), 'a');
  assert.equal(code(() => contains(clock, null)), 'ERR_BAD_DOT');
  assert.equal(code(() => contains(clock, 5)), 'ERR_BAD_DOT');
  assert.equal(code(() => contains(clock, { id: '', counter: 1 })), 'ERR_BAD_DOT');
  assert.equal(code(() => contains(clock, { id: 'a' })), 'ERR_BAD_DOT');
  assert.equal(code(() => contains(clock, { id: 'a', counter: 0 })), 'ERR_BAD_DOT');
  assert.equal(code(() => contains(clock, { id: 'a', counter: 2.5 })), 'ERR_BAD_DOT');
  assert.equal(contains(clock, { id: 'a', counter: 9 }), false);
  assert.equal(code(() => contains([run('a', 1, 1), run('a', 2, 2)], { id: 'a', counter: 1 })), 'ERR_BAD_CLOCK');
});
