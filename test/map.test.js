import test from 'node:test';
import assert from 'node:assert/strict';

import { createMap } from '../lib/avlmap.js';
import { code } from './util.js';

test('set / get / has / size：老键换值不算新增', () => {
  const map = createMap();
  assert.equal(map.size(), 0);
  assert.equal(map.has(1), false);
  assert.equal(map.get(1), undefined);
  map.set(1, 'one').set(2, 'two').set(3, 'three');
  assert.equal(map.size(), 3);
  assert.equal(map.get(2), 'two');
  assert.equal(map.has(2), true);
  map.set(2, 'TWO');
  assert.equal(map.size(), 3);
  assert.equal(map.get(2), 'TWO');
  assert.deepEqual(map.entries(), [[1, 'one'], [2, 'TWO'], [3, 'three']]);
});

test('键是整数键，值随便放（连 undefined 也行）', () => {
  const map = createMap();
  const payload = { deep: [1, 2, 3] };
  map.set(-7, payload);
  map.set(0, undefined);
  map.set(2 ** 40, 'big');
  assert.equal(map.get(-7), payload);
  assert.equal(map.has(0), true);
  assert.equal(map.get(0), undefined);
  assert.equal(map.get(2 ** 40), 'big');
  assert.deepEqual(map.entries(), [[-7, payload], [0, undefined], [2 ** 40, 'big']]);
});

test('remove 的返回值与结构变化', () => {
  const map = createMap();
  for (const key of [5, 3, 8, 1, 4, 7, 9, 2, 6, 10]) map.set(key, key * 10);
  assert.equal(map.remove(99), false);
  assert.equal(map.size(), 10);
  assert.equal(map.remove(5), true);
  assert.equal(map.has(5), false);
  assert.equal(map.size(), 9);
  assert.equal(map.remove(5), false);
  assert.deepEqual(map.entries().map(([key]) => key), [1, 2, 3, 4, 6, 7, 8, 9, 10]);

  for (const key of [1, 2, 3, 4, 6, 7, 8, 9, 10]) map.remove(key);
  assert.equal(map.size(), 0);
  assert.deepEqual(map.entries(), []);
  assert.equal(map.min(), null);
  assert.equal(map.max(), null);
  assert.equal(map.height(), 0);
  map.set(42, 'back');
  assert.deepEqual(map.entries(), [[42, 'back']]);
  assert.equal(map.height(), 1);
  assert.equal(map.remove(42), true);
  assert.equal(map.size(), 0);
});

test('clear 之后是干净的空表', () => {
  const map = createMap();
  for (const key of [3, 1, 2]) map.set(key, key);
  map.clear();
  assert.equal(map.size(), 0);
  assert.equal(map.height(), 0);
  assert.deepEqual(map.entries(), []);
  assert.equal(map.get(1), undefined);
  assert.equal(map.min(), null);
  assert.equal(map.at(0), null);
  assert.equal(map.indexOf(1), -1);
  assert.deepEqual(map.range(-10, 10), []);
});

test('键不是安全整数一律 ERR_BAD_ARGUMENT', () => {
  const map = createMap();
  for (const key of [1.5, NaN, Infinity, -Infinity, '1', null, undefined, 2 ** 53, 10 ** 20]) {
    assert.equal(code(() => map.set(key, 1)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => map.get(key)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => map.has(key)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => map.remove(key)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => map.indexOf(key)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => map.range(key, 10)), 'ERR_BAD_ARGUMENT');
    assert.equal(code(() => map.range(0, key)), 'ERR_BAD_ARGUMENT');
  }
  assert.equal(map.size(), 0);
});