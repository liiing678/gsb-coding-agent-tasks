import test from 'node:test';
import assert from 'node:assert/strict';

import { createIndex } from '../lib/typemap.js';
import { expectedFuzzy, expectedNodes, expectedPrefix, expectedTop } from './util.js';

const model = new Map([['cat', 5], ['car', 3], ['card', 9], ['dog', 1], ['do', 2], ['dot', 1]]);
const sample = () => createIndex([['cat', 5], ['car', 3], ['card', 9], ['dog', 1], ['do', 2], 'dot']);

test('插入、查权重、查在不在', () => {
  const index = createIndex();
  assert.equal(index.insert('a'), true);
  assert.equal(index.insert('a', 5), false);
  assert.equal(index.weight('a'), 5);
  assert.equal(index.insert('ab'), true);
  assert.equal(index.has('a'), true);
  assert.equal(index.has('ab'), true);
  assert.equal(index.has('abc'), false);
  assert.equal(index.weight('ab'), 1);
  assert.equal(index.weight('abc'), null);
  assert.deepEqual(index.stats(), { terms: 2, nodes: expectedNodes(['a', 'ab']) });
  assert.equal(index.insert('a', 0), false);
  assert.equal(index.weight('a'), 0);
  assert.equal(index.insert('a', -2.5), false);
  assert.equal(index.weight('a'), -2.5);
  const others = createIndex(['x', ['y', 4]]);
  assert.deepEqual(others.top(10), [{ term: 'y', weight: 4 }, { term: 'x', weight: 1 }]);
});

test('prefix：排序、limit 与半截边', () => {
  const index = sample();
  assert.deepEqual(index.prefix('c', 10), expectedPrefix(model, 'c', 10));
  assert.deepEqual(index.prefix('ca', 10), expectedPrefix(model, 'ca', 10));
  assert.deepEqual(index.prefix('car', 10), expectedPrefix(model, 'car', 10));
  assert.deepEqual(index.prefix('d', 10), expectedPrefix(model, 'd', 10));
  assert.deepEqual(index.prefix('c', 2), [
    { term: 'card', weight: 9 },
    { term: 'cat', weight: 5 },
  ]);
  assert.deepEqual(index.prefix('', 3), expectedTop(model, 3));
  assert.deepEqual(index.prefix('z'), []);
  assert.deepEqual(index.prefix('do'), expectedPrefix(model, 'do', 10));
  assert.deepEqual(index.prefix('ca', 0), []);
  assert.deepEqual(index.prefix('cat', 10), [{ term: 'cat', weight: 5 }]);
  assert.deepEqual(index.prefix('CAT'), []);
});

test('top 与 fuzzy 的排序', () => {
  const index = sample();
  assert.deepEqual(index.top(10), expectedTop(model, 10));
  assert.deepEqual(index.top(2), expectedTop(model, 2));
  assert.deepEqual(index.top(0), []);
  assert.deepEqual(index.fuzzy('cat', 1, 10), expectedFuzzy(model, 'cat', 1, 10));
  assert.deepEqual(index.fuzzy('cot', 2, 10), expectedFuzzy(model, 'cot', 2, 10));
  assert.deepEqual(index.fuzzy('cat', 0, 10), [{ term: 'cat', weight: 5 }]);
  assert.deepEqual(index.fuzzy('cxt', 1, 10), expectedFuzzy(model, 'cxt', 1, 10));
  assert.deepEqual(index.fuzzy('zzzz', 2, 10), expectedFuzzy(model, 'zzzz', 2, 10));
  assert.deepEqual(index.fuzzy('cat', 1, 1), expectedFuzzy(model, 'cat', 1, 1));
  assert.deepEqual(index.fuzzy('anything', 3, 0), []);
  assert.deepEqual(index.fuzzy('card', 1, 10), expectedFuzzy(model, 'card', 1, 10));
});

test('remove 会把结构收回去', () => {
  const index = sample();
  assert.equal(index.remove('card'), true);
  assert.equal(index.remove('card'), false);
  assert.equal(index.remove('nope'), false);
  const left = new Map([...model].filter(([term]) => term !== 'card'));
  assert.deepEqual(index.stats(), { terms: left.size, nodes: expectedNodes([...left.keys()]) });
  assert.deepEqual(index.prefix('ca', 10), expectedPrefix(left, 'ca', 10));
  assert.deepEqual(index.top(10), expectedTop(left, 10));
  assert.deepEqual(index.fuzzy('cot', 2, 10), expectedFuzzy(left, 'cot', 2, 10));

  const built = sample();
  assert.equal(built.insert('card', 9), false);
  assert.deepEqual(built.stats(), { terms: model.size, nodes: expectedNodes([...model.keys()]) });
  built.remove('do');
  assert.equal(built.has('do'), false);
  assert.equal(built.has('dot'), true);
  assert.deepEqual(built.prefix('do', 10), [{ term: 'dog', weight: 1 }, { term: 'dot', weight: 1 }]);
  const withoutDo = [...model.keys()].filter((term) => term !== 'do');
  assert.deepEqual(built.stats(), { terms: withoutDo.length, nodes: expectedNodes(withoutDo) });
});

test('随机操作序列跟朴素模型逐项对比', () => {
  const index = createIndex();
  const model2 = new Map();
  const words = [];
  for (let outer = 0; outer < 3; outer += 1) {
    for (let inner = 0; inner < 100; inner += 1) {
      words.push(`${'abc'[outer]}${inner % 7}${'xyz'[inner % 3]}`);
    }
  }
  for (let step = 0; step < 600; step += 1) {
    const word = words[(step * 37) % words.length];
    if (step % 3 === 0 && model2.has(word)) {
      assert.equal(index.remove(word), true);
      model2.delete(word);
    } else {
      const weight = (step % 11) - 3;
      assert.equal(index.insert(word, weight), !model2.has(word));
      model2.set(word, weight);
    }
    if (step % 25 === 0) {
      assert.deepEqual(index.stats(), { terms: model2.size, nodes: expectedNodes([...model2.keys()]) });
    }
    if (step % 40 === 0) {
      assert.deepEqual(index.top(7), expectedTop(model2, 7));
    }
    if (step % 55 === 0) {
      const prefix = `${'abc'[(step / 55) % 3]}${step % 4}`;
      assert.deepEqual(index.prefix(prefix, 5), expectedPrefix(model2, prefix, 5));
    }
  }
  for (const [term, weight] of model2) assert.equal(index.weight(term), weight);
  assert.deepEqual(index.stats(), { terms: model2.size, nodes: expectedNodes([...model2.keys()]) });
});
