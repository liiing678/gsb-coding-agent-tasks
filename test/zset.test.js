import test from 'node:test';
import assert from 'node:assert/strict';

import { createZset } from '../lib/skipzset.js';
import { code } from './util.js';

test('add 的返回值、score 与 size', () => {
  const zset = createZset();
  assert.equal(zset.size(), 0);
  assert.equal(zset.add('a', 3), 1);
  assert.equal(zset.add('b', 1), 1);
  assert.equal(zset.add('a', 3), 0);          // 分数没变，还是老成员
  assert.equal(zset.add('a', 7), 0);          // 改分也算老成员
  assert.equal(zset.size(), 2);
  assert.equal(zset.score('a'), 7);
  assert.equal(zset.score('b'), 1);
  assert.equal(zset.score('nope'), null);
});

test('排队是按分数升序，同分按成员升序，entries 给的是新数组', () => {
  const zset = createZset();
  zset.add('pear', 2);
  zset.add('apple', 2);
  zset.add('fig', 1);
  zset.add('date', 9);
  assert.deepEqual(zset.entries(), [
    ['fig', 1],
    ['apple', 2],
    ['pear', 2],
    ['date', 9],
  ]);
  const snapshot = zset.entries();
  snapshot.push(['zzz', 100]);
  snapshot[1][1] = -5;
  assert.deepEqual(zset.entries(), [
    ['fig', 1],
    ['apple', 2],
    ['pear', 2],
    ['date', 9],
  ]);
  assert.deepEqual(zset.range(0, -1), ['fig', 'apple', 'pear', 'date']);
});

test('rank / revRank 是 0 基，改分之后名次跟着动', () => {
  const zset = createZset();
  zset.add('a', 1);
  zset.add('b', 2);
  zset.add('c', 2);
  zset.add('d', 3);
  assert.equal(zset.rank('a'), 0);
  assert.equal(zset.rank('b'), 1);
  assert.equal(zset.rank('c'), 2);
  assert.equal(zset.rank('d'), 3);
  assert.equal(zset.revRank('a'), 3);
  assert.equal(zset.revRank('b'), 2);
  assert.equal(zset.revRank('d'), 0);
  assert.equal(zset.rank('nope'), null);
  assert.equal(zset.revRank('nope'), null);
  zset.add('a', 4);
  assert.equal(zset.rank('a'), 3);
  assert.equal(zset.revRank('a'), 0);
});

test('range 支持负下标与越界截断', () => {
  const zset = createZset();
  for (const [member, score] of [['a', 1], ['b', 2], ['c', 3], ['d', 4]]) zset.add(member, score);
  assert.deepEqual(zset.range(0, 1), ['a', 'b']);
  assert.deepEqual(zset.range(1, -2), ['b', 'c']);
  assert.deepEqual(zset.range(-2, -1), ['c', 'd']);
  assert.deepEqual(zset.range(-99, 99), ['a', 'b', 'c', 'd']);
  assert.deepEqual(zset.range(3, 1), []);
  assert.deepEqual(zset.range(4, 5), []);
  assert.deepEqual(zset.range(-1, -3), []);
  assert.deepEqual(createZset().range(0, -1), []);
});

test('remove 与 clear', () => {
  const zset = createZset();
  zset.add('a', 1);
  zset.add('b', 2);
  assert.equal(zset.remove('a'), 1);
  assert.equal(zset.remove('a'), 0);
  assert.equal(zset.size(), 1);
  assert.equal(zset.score('a'), null);
  assert.equal(zset.rank('b'), 0);
  zset.clear();
  assert.equal(zset.size(), 0);
  assert.deepEqual(zset.entries(), []);
  assert.deepEqual(zset.range(0, -1), []);
  assert.equal(zset.rank('b'), null);
});

test('入参不对一律 ERR_BAD_ARGUMENT', () => {
  const zset = createZset();
  zset.add('a', 1);
  for (const member of ['', 7, null, undefined, ['a']]) {
    assert.equal(code(() => zset.add(member, 1)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => zset.score(member)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => zset.remove(member)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => zset.rank(member)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => zset.revRank(member)), 'ERR_BAD_ARGUMENT');
  }
  for (const score of [NaN, Infinity, -Infinity, '1', null, undefined]) {
    assert.equal(code(() => zset.add('x', score)), 'ERR_BAD_ARGUMENT');
  }
  for (const bad of [1.5, NaN, '0', null]) {
    assert.equal(code(() => zset.range(bad, 1)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => zset.range(0, bad)), 'ERR_BAD_ARGUMENT');
  }
});