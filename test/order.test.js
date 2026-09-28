import test from 'node:test';
import assert from 'node:assert/strict';

import { createMap } from '../lib/avlmap.js';
import { Rand, code, heightBound, sortedKeys } from './util.js';

const fill = (keys) => {
  const map = createMap();
  for (const key of keys) map.set(key, `v${key}`);
  return map;
};

test('at / indexOf 都是 0 基，越界给 null / -1', () => {
  const map = fill([4, 2, 6, 1, 3, 5, 7]);
  assert.deepEqual(map.at(0), [1, 'v1']);
  assert.deepEqual(map.at(3), [4, 'v4']);
  assert.deepEqual(map.at(6), [7, 'v7']);
  assert.equal(map.at(7), null);
  assert.equal(map.at(-1), null);
  assert.equal(map.at(1e9), null);
  assert.equal(map.indexOf(1), 0);
  assert.equal(map.indexOf(4), 3);
  assert.equal(map.indexOf(7), 6);
  assert.equal(map.indexOf(8), -1);
  assert.equal(code(() => map.at(1.5)), 'ERR_BAD_ARGUMENT');
});

test('range 是闭区间，空区间给空数组', () => {
  const map = fill([10, 20, 30, 40, 50]);
  assert.deepEqual(map.range(20, 40), [[20, 'v20'], [30, 'v30'], [40, 'v40']]);
  assert.deepEqual(map.range(20, 20), [[20, 'v20']]);
  assert.deepEqual(map.range(-5, 15), [[10, 'v10']]);
  assert.deepEqual(map.range(45, 100), [[50, 'v50']]);
  assert.deepEqual(map.range(41, 49), []);
  assert.deepEqual(map.range(40, 20), []);
  assert.deepEqual(map.range(100, 200), []);
  const snapshot = map.range(10, 50);
  snapshot.push([999, 'x']);
  snapshot[0][1] = 'changed';
  assert.deepEqual(map.range(10, 50), [[10, 'v10'], [20, 'v20'], [30, 'v30'], [40, 'v40'], [50, 'v50']]);
});

test('min / max / height 的口径', () => {
  const map = createMap();
  assert.deepEqual([map.min(), map.max(), map.height()], [null, null, 0]);
  map.set(5, 'five');
  assert.deepEqual([map.min(), map.max(), map.height()], [[5, 'five'], [5, 'five'], 1]);
  map.set(3, 'three').set(8, 'eight');
  assert.equal(map.height(), 2);
  map.set(1, 'one').set(4, 'four').set(7, 'seven').set(9, 'nine');
  assert.deepEqual(map.min(), [1, 'one']);
  assert.deepEqual(map.max(), [9, 'nine']);
  assert.ok(map.height() <= heightBound(map.size()));
});

test('递增 / 递减插入也要长出平衡的高度', () => {
  const up = createMap();
  for (let key = 1; key <= 4096; key += 1) up.set(key, key);
  assert.equal(up.size(), 4096);
  assert.ok(up.height() <= heightBound(4096), `递增插入高到了 ${up.height()}`);
  assert.ok(up.height() >= Math.ceil(Math.log2(4097)));

  const down = createMap();
  for (let key = 4096; key >= 1; key -= 1) down.set(key, key);
  assert.ok(down.height() <= heightBound(4096), `递减插入高到了 ${down.height()}`);

  const zigzag = createMap();
  for (let key = 0; key < 4096; key += 1) {
    zigzag.set(key % 2 === 0 ? key : 4096 - key, key);
  }
  assert.ok(zigzag.height() <= heightBound(zigzag.size()), `锯齿插入高到了 ${zigzag.height()}`);
});

test('一边加一边删，高度也不许失控', () => {
  const map = createMap();
  const rand = new Rand(65);
  const live = new Set();
  for (let step = 0; step < 6000; step += 1) {
    const key = rand.below(4000);
    if (rand.below(3) === 0 && live.size > 0) {
      assert.equal(map.remove(key), live.delete(key));
    } else {
      map.set(key, step);
      live.add(key);
    }
    if (step % 500 === 0) {
      assert.equal(map.size(), live.size);
      assert.ok(map.height() <= heightBound(live.size), `第 ${step} 步高到了 ${map.height()}`);
      assert.deepEqual(map.entries().map(([key]) => key), sortedKeys(live));
    }
  }
  for (const key of sortedKeys(live)) map.remove(key);
  assert.equal(map.size(), 0);
  assert.equal(map.height(), 0);
});

test('名次查询不许整棵树扫一遍', () => {
  const map = createMap();
  for (let key = 0; key < 5000; key += 1) map.set(key, key);
  const ceiling = heightBound(map.size());
  for (const index of [0, 1, 123, 2500, 4998, 4999]) {
    assert.deepEqual(map.at(index), [index, index]);
    assert.equal(map.stats().visited <= ceiling, true, `at(${index}) 摸了 ${map.stats().visited} 个节点（上限 ${ceiling}）`);
  }
  for (const key of [0, 17, 2500, 4999]) {
    assert.equal(map.indexOf(key), key);
    assert.equal(map.stats().visited <= ceiling, true, `indexOf(${key}) 摸了 ${map.stats().visited} 个节点`);
  }
  assert.equal(map.stats().nodes, map.size());
  assert.equal(map.stats().height, map.height());
});

test('和朴素实现逐项对比（固定的伪随机操作序列）', () => {
  const map = createMap();
  const model = new Map();
  const rand = new Rand(650);
  for (let step = 0; step < 1500; step += 1) {
    const key = rand.below(600) - 200;
    if (rand.below(4) === 0) {
      assert.equal(map.remove(key), model.delete(key));
    } else {
      const value = `#${step}`;
      map.set(key, value);
      model.set(key, value);
    }
    assert.equal(map.size(), model.size);
  }

  const keys = sortedKeys(model);
  assert.deepEqual(map.entries(), keys.map((key) => [key, model.get(key)]));
  assert.deepEqual(map.min(), keys.length ? [keys[0], model.get(keys[0])] : null);
  assert.deepEqual(map.max(), keys.length ? [keys[keys.length - 1], model.get(keys[keys.length - 1])] : null);
  for (let index = 0; index < keys.length; index += 1) {
    assert.deepEqual(map.at(index), [keys[index], model.get(keys[index])]);
    assert.equal(map.indexOf(keys[index]), index);
  }
  for (let step = 0; step < 200; step += 1) {
    const from = rand.below(600) - 200;
    const to = from + rand.below(80);
    assert.deepEqual(map.range(from, to),
      keys.filter((key) => key >= from && key <= to).map((key) => [key, model.get(key)]));
  }
  assert.ok(map.height() <= heightBound(model.size));
});