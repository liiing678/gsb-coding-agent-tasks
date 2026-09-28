import test from 'node:test';
import assert from 'node:assert/strict';

import { createIndex } from '../lib/typemap.js';
import { code, expectedFuzzy, expectedNodes, expectedPrefix, expectedTop } from './util.js';

test('入参校验', () => {
  const index = createIndex();
  for (const term of ['', 7, null, undefined, {}, [], true]) {
    assert.equal(code(() => index.insert(term)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => index.has(term)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => index.weight(term)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => index.remove(term)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => index.fuzzy(term, 1)), 'ERR_BAD_ARGUMENT');
  }
  for (const weight of [NaN, Infinity, -Infinity, '1', null, {}, []]) {
    assert.equal(code(() => index.insert('a', weight)), 'ERR_BAD_ARGUMENT');
  }
  for (const limit of [-1, 1.5, '3', null, {}]) {
    assert.equal(code(() => index.prefix('a', limit)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => index.top(limit)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => index.fuzzy('a', 1, limit)), 'ERR_BAD_ARGUMENT');
  }
  for (const maxDistance of [-1, 0.5, '1', null]) {
    assert.equal(code(() => index.fuzzy('a', maxDistance)), 'ERR_BAD_ARGUMENT');
  }
  for (const options of [null, [], 'x', 7, true]) {
    assert.equal(code(() => index.fuzzy('a', 1, 10, options)), 'ERR_BAD_ARGUMENT');
  }
  for (const maxVisits of [0, -1, 1.5, '10', null]) {
    assert.equal(code(() => index.fuzzy('a', 1, 10, { maxVisits })), 'ERR_BAD_ARGUMENT');
  }
  for (const entries of ['x', 7, null, {}, [1], [['a']], [[1, 2]], [[null, 1]]]) {
    assert.equal(code(() => createIndex(entries)), 'ERR_BAD_ARGUMENT');
  }
  assert.equal(code(() => createIndex()), null);
  assert.equal(code(() => createIndex([])), null);
  assert.equal(code(() => createIndex(['a', ['b', 2]])), null);
  assert.equal(code(() => index.insert('a', undefined)), null);
  assert.equal(code(() => index.prefix('a', undefined)), null);
});

test('fuzzy 的访问预算', () => {
  const words = [];
  for (let index = 0; index < 200; index += 1) words.push(`w${index.toString(36)}`);
  const index = createIndex(words);
  assert.ok(index.fuzzy('w1', 1, 10).length > 0);
  assert.ok(index.fuzzy('w1', 3, 50, { maxVisits: 100000 }).length >= 0);
  try {
    index.fuzzy('w1', 3, 50, { maxVisits: 5 });
    assert.fail('预算用完了应该抛');
  } catch (err) {
    assert.equal(err.code, 'ERR_BUDGET_EXCEEDED');
    assert.ok(Number.isInteger(err.details.visits));
    assert.ok(err.details.visits > 5);
  }
  assert.equal(code(() => index.fuzzy('w1', 3, 50, { maxVisits: 1 })), 'ERR_BUDGET_EXCEEDED');
  const small = createIndex(['ab', 'ac']);
  assert.deepEqual(small.fuzzy('ab', 0, 10, { maxVisits: 1000 }), [{ term: 'ab', weight: 1 }]);
});

test('按码元算：emoji 是两个码元，大小写分开', () => {
  const model = new Map([['😀', 1], ['😀a', 2], ['\uD83D', 3], ['a\nb', 4]]);
  const index = createIndex([...model]);
  assert.deepEqual(index.prefix('😀', 10), expectedPrefix(model, '😀', 10));
  assert.deepEqual(index.prefix('\uD83D', 10), expectedPrefix(model, '\uD83D', 10));
  assert.deepEqual(index.prefix('\uD83D', 10), [
    { term: '\uD83D', weight: 3 },
    { term: '😀a', weight: 2 },
    { term: '😀', weight: 1 },
  ]);
  assert.deepEqual(index.fuzzy('\uD83D', 1, 10), [
    { term: '\uD83D', weight: 3 },
    { term: '😀', weight: 1 },
  ]);
  assert.deepEqual(index.fuzzy('😀a', 0, 10), [{ term: '😀a', weight: 2 }]);
  assert.deepEqual(index.fuzzy('a\nb', 0, 10), [{ term: 'a\nb', weight: 4 }]);
  assert.deepEqual(index.fuzzy('ab', 1, 10), expectedFuzzy(model, 'ab', 1, 10));
  const cased = createIndex(['Ada', 'ada', 'ADA']);
  assert.deepEqual(cased.top(10), [
    { term: 'ADA', weight: 1 },
    { term: 'Ada', weight: 1 },
    { term: 'ada', weight: 1 },
  ]);
  assert.deepEqual(cased.prefix('a', 10), [{ term: 'ada', weight: 1 }]);
});

test('createIndex 的两种写法与重复词', () => {
  const index = createIndex(['a', ['a', 7], ['b', 2], ['a', 1]]);
  assert.deepEqual(index.stats(), { terms: 2, nodes: expectedNodes(['a', 'b']) });
  assert.equal(index.weight('a'), 1);
  assert.deepEqual(index.top(10), [{ term: 'b', weight: 2 }, { term: 'a', weight: 1 }]);
  const duplicates = createIndex();
  assert.equal(duplicates.insert('x', 1), true);
  assert.equal(duplicates.insert('x', 2), false);
  assert.deepEqual(duplicates.stats(), { terms: 1, nodes: expectedNodes(['x']) });
});

test('两千个词也扛得住，结果跟朴素实现一致', () => {
  const model = new Map();
  const words = [];
  for (let index = 0; index < 2000; index += 1) {
    const word = `n${index.toString(36)}-${index % 13}`;
    words.push(word);
    model.set(word, (index * 7) % 11);
  }
  const index = createIndex(words.map((word) => [word, model.get(word)]));
  assert.deepEqual(index.stats(), { terms: model.size, nodes: expectedNodes([...model.keys()]) });
  assert.deepEqual(index.top(12), expectedTop(model, 12));
  assert.deepEqual(index.prefix('n1', 15), expectedPrefix(model, 'n1', 15));
  assert.deepEqual(index.prefix('n1a', 15), expectedPrefix(model, 'n1a', 15));
  assert.deepEqual(index.fuzzy('n1a', 1, 15), expectedFuzzy(model, 'n1a', 1, 15));
  assert.deepEqual(index.fuzzy('n1a', 2, 15), expectedFuzzy(model, 'n1a', 2, 15));
  for (const word of words.slice(0, 500)) index.remove(word);
  for (const word of words.slice(0, 500)) model.delete(word);
  assert.deepEqual(index.stats(), { terms: model.size, nodes: expectedNodes([...model.keys()]) });
  assert.deepEqual(index.top(12), expectedTop(model, 12));
});

test('同样的操作得到同样的结果', () => {
  const build = () => {
    const index = createIndex();
    for (const word of ['go', 'gone', 'gong', 'good', 'god', 'goad']) index.insert(word, word.length);
    index.remove('goad');
    return index;
  };
  const left = build();
  const right = build();
  assert.deepEqual(left.top(10), right.top(10));
  assert.deepEqual(left.prefix('go', 10), right.prefix('go', 10));
  assert.deepEqual(left.fuzzy('good', 2, 10), right.fuzzy('good', 2, 10));
  assert.deepEqual(left.stats(), right.stats());
  assert.deepEqual(left.fuzzy('good', 2, 10).map((item) => item.term), ['good', 'god', 'gone', 'gong', 'go']);
  assert.deepEqual(left.prefix('go', 10).map((item) => item.term), ['gone', 'gong', 'good', 'god', 'go']);
});
