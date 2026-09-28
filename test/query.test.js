import test from 'node:test';
import assert from 'node:assert/strict';

import { createZset } from '../lib/skipzset.js';
import { Rand, code, naiveOrder } from './util.js';

const sample = () => {
  const zset = createZset();
  zset.add('a', 1);
  zset.add('b', 2);
  zset.add('c', 2);
  zset.add('d', 5);
  zset.add('e', 8);
  return zset;
};

test('rangeByScore 是闭区间，边界可以用正负无穷', () => {
  const zset = sample();
  assert.deepEqual(zset.rangeByScore(2, 5), ['b', 'c', 'd']);
  assert.deepEqual(zset.rangeByScore(2, 2), ['b', 'c']);
  assert.deepEqual(zset.rangeByScore(-Infinity, Infinity), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(zset.rangeByScore(2.5, Infinity), ['d', 'e']);
  assert.deepEqual(zset.rangeByScore(-Infinity, 1), ['a']);
  assert.deepEqual(zset.rangeByScore(5, 2), []);
  assert.deepEqual(zset.rangeByScore(6, 7), []);
  assert.equal(zset.countByScore(2, 5), 3);
  assert.equal(zset.countByScore(-Infinity, Infinity), 5);
  assert.equal(zset.countByScore(99, 100), 0);
});

test('rangeByLex 的端点写法与开闭区间', () => {
  const zset = createZset();
  for (const member of ['apple', 'banana', 'cherry', 'date']) zset.add(member, 0);
  assert.deepEqual(zset.rangeByLex('-', '+'), ['apple', 'banana', 'cherry', 'date']);
  assert.deepEqual(zset.rangeByLex('[banana', '[date'), ['banana', 'cherry', 'date']);
  assert.deepEqual(zset.rangeByLex('(banana', '[date'), ['cherry', 'date']);
  assert.deepEqual(zset.rangeByLex('[b', '(date'), ['banana', 'cherry']);
  assert.deepEqual(zset.rangeByLex('(cherry', '+'), ['date']);
  assert.deepEqual(zset.rangeByLex('-', '(apple'), []);
  assert.deepEqual(zset.rangeByLex('+', '+'), []);
  assert.deepEqual(zset.rangeByLex('-', '-'), []);
  assert.deepEqual(zset.rangeByLex('[zzz', '+'), []);
  assert.deepEqual(zset.rangeByLex('(', '+'), ['apple', 'banana', 'cherry', 'date']);
});

test('rangeByLex 用的是成员自己的字符串序，跟分数没关系', () => {
  const zset = createZset();
  zset.add('b', 1);
  zset.add('a', 9);
  zset.add('c', 5);
  assert.deepEqual(zset.rangeByLex('-', '+'), ['a', 'b', 'c']);
  assert.deepEqual(zset.entries(), [['b', 1], ['c', 5], ['a', 9]]);
});

test('范围查询的入参错误分开报', () => {
  const zset = sample();
  for (const bad of [NaN, '2', null, undefined]) {
    assert.equal(code(() => zset.rangeByScore(bad, 5)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => zset.rangeByScore(1, bad)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => zset.countByScore(bad, 5)), 'ERR_BAD_ARGUMENT');
  }
  for (const bad of ['', 'b', 7, null, undefined]) {
    assert.equal(code(() => zset.rangeByLex(bad, '+')), 'ERR_BAD_BOUND');
    assert.equal(code(() => zset.rangeByLex('-', bad)), 'ERR_BAD_BOUND');
  }
});

test('和朴素实现逐项对比（固定的伪随机操作序列）', () => {
  const zset = createZset();
  const map = new Map();
  const rand = new Rand(20260924);
  const members = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];

  for (let step = 0; step < 600; step += 1) {
    const member = members[rand.below(members.length)];
    if (rand.below(4) === 0) {
      assert.equal(zset.remove(member), map.delete(member) ? 1 : 0);
    } else {
      const score = rand.below(20);
      assert.equal(zset.add(member, score), map.has(member) ? 0 : 1);
      map.set(member, score);
    }
    const expected = naiveOrder(map);
    assert.deepEqual(zset.entries(), expected.map((entry) => [entry.member, entry.score]));
    assert.equal(zset.size(), map.size);
    for (const entry of expected) {
      assert.equal(zset.score(entry.member), entry.score);
    }
  }

  for (let step = 0; step < 200; step += 1) {
    const start = rand.below(12) - 3;
    const stop = rand.below(12) - 3;
    const list = naiveOrder(map);
    const total = list.length;
    let from = start < 0 ? total + start : start;
    let to = stop < 0 ? total + stop : stop;
    if (from < 0) from = 0;
    if (to >= total) to = total - 1;
    const expected = total === 0 || from > to || from >= total
      ? []
      : list.slice(from, to + 1).map((entry) => entry.member);
    assert.deepEqual(zset.range(start, stop), expected);

    const low = rand.below(24) - 2;
    const high = low + rand.below(6);
    assert.deepEqual(zset.rangeByScore(low, high),
      naiveOrder(map).filter((entry) => entry.score >= low && entry.score <= high)
        .map((entry) => entry.member));

    const member = members[rand.below(members.length)];
    const index = naiveOrder(map).findIndex((entry) => entry.member === member);
    assert.equal(zset.rank(member), index === -1 ? null : index);
    assert.equal(zset.revRank(member), index === -1 ? null : total - 1 - index);
  }

  for (const [member, score] of zset.entries()) {
    zset.add(member, score + 100);
  }
  assert.deepEqual(zset.entries().map((entry) => entry[0]),
    naiveOrder(map).map((entry) => entry.member));
});