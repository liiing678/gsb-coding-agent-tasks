import test from 'node:test';
import assert from 'node:assert/strict';

import { and, createBitmap, equals, or, xor } from '../lib/roarbit.js';
import { bitmapOf, code, range, shuffled } from './util.js';

test('and / or / xor 的基本口径，入参不动', () => {
  const left = bitmapOf([1, 2, 3, 70000]);
  const right = bitmapOf([3, 4, 70000, 70001]);

  assert.deepEqual(and(left, right).toArray(), [3, 70000]);
  assert.deepEqual(or(left, right).toArray(), [1, 2, 3, 4, 70000, 70001]);
  assert.deepEqual(xor(left, right).toArray(), [1, 2, 4, 70001]);
  assert.deepEqual(or(left, right).containers(), [
    { key: 0, kind: 'array', count: 4 },
    { key: 1, kind: 'array', count: 2 },
  ]);

  assert.deepEqual(left.toArray(), [1, 2, 3, 70000]);
  assert.deepEqual(right.toArray(), [3, 4, 70000, 70001]);
  assert.equal(left.size(), 4);
  assert.equal(right.size(), 4);

  assert.deepEqual(and(left, createBitmap()).containers(), []);
  assert.equal(and(left, createBitmap()).size(), 0);
  assert.deepEqual(or(left, createBitmap()).toArray(), [1, 2, 3, 70000]);
  assert.deepEqual(xor(left, createBitmap()).toArray(), [1, 2, 3, 70000]);
});

test('or 的结果超过 4096 个要换位图容器', () => {
  const left = bitmapOf(range(0, 3000));
  const right = bitmapOf(range(3000, 2500));
  const union = or(left, right);
  assert.equal(union.size(), 5500);
  assert.deepEqual(union.containers(), [{ key: 0, kind: 'bitmap', count: 5500 }]);
  assert.deepEqual(union.toArray(), range(0, 5500));
  assert.equal(union.has(5499), true);

  const overlap = or(bitmapOf(range(0, 4000)), bitmapOf(range(3000, 3000)));
  assert.equal(overlap.size(), 6000);
  assert.deepEqual(overlap.containers(), [{ key: 0, kind: 'bitmap', count: 6000 }]);

  // 数组容器之间的交集一定不超过 4096，结果还是数组容器
  assert.deepEqual(
    and(bitmapOf(range(0, 4000)), bitmapOf(range(3000, 3000))).containers(),
    [{ key: 0, kind: 'array', count: 1000 }],
  );
});

test('xor 两边都有的点要丢掉', () => {
  const bitmap = bitmapOf(range(0, 5000));
  const none = xor(bitmap, bitmapOf(range(0, 5000)));
  assert.equal(none.size(), 0);
  assert.deepEqual(none.containers(), []);

  // 两个位图容器做 xor，结果掉到 4096 以下要换回数组容器
  const shrunk = xor(bitmap, bitmapOf(range(0, 4500)));
  assert.deepEqual(shrunk.containers(), [{ key: 0, kind: 'array', count: 500 }]);
  assert.deepEqual(shrunk.toArray(), range(4500, 500));

  // 位图容器减数组容器
  const mixed = xor(bitmap, bitmapOf(range(0, 1000)));
  assert.deepEqual(mixed.containers(), [{ key: 0, kind: 'array', count: 4000 }]);
  assert.deepEqual(mixed.toArray(), range(1000, 4000));

  // 位图容器除了要删的还多出一些新点，结果还是位图容器
  const crossed = xor(bitmap, bitmapOf(range(4000, 3000)));
  assert.equal(crossed.size(), 6000);
  assert.deepEqual(crossed.containers(), [{ key: 0, kind: 'bitmap', count: 6000 }]);
  assert.deepEqual(crossed.toArray(), [...range(0, 4000), ...range(5000, 2000)]);

  // 两个位图容器之间的对称差还是位图容器
  const grown = xor(bitmap, bitmapOf(range(4000, 5000)));
  assert.equal(grown.size(), 8000);
  assert.deepEqual(grown.containers(), [{ key: 0, kind: 'bitmap', count: 8000 }]);
  assert.deepEqual(grown.toArray(), [...range(0, 4000), ...range(5000, 4000)]);

  assert.deepEqual(xor(bitmapOf(range(0, 3000)), bitmapOf(range(0, 2000))).toArray(), range(2000, 1000));
  assert.deepEqual(xor(bitmapOf([5, 6, 7]), bitmapOf([6, 7, 8])).toArray(), [5, 8]);
});

test('跨桶和混合容器都要对', () => {
  const wide = bitmapOf([...range(0, 5000), ...range(70000, 5000)]);
  const narrow = bitmapOf([...range(0, 100), ...range(70000, 100)]);
  assert.deepEqual(wide.containers(), [
    { key: 0, kind: 'bitmap', count: 5000 },
    { key: 1, kind: 'bitmap', count: 5000 },
  ]);

  assert.equal(and(wide, narrow).size(), 200);
  assert.deepEqual(and(wide, narrow).toArray(), [...range(0, 100), ...range(70000, 100)]);

  const union = or(wide, narrow);
  assert.equal(union.size(), 10000);
  assert.deepEqual(union.containers(), [
    { key: 0, kind: 'bitmap', count: 5000 },
    { key: 1, kind: 'bitmap', count: 5000 },
  ]);

  const diff = xor(wide, narrow);
  assert.equal(diff.size(), 9800);
  assert.deepEqual(diff.toArray().slice(0, 3), [100, 101, 102]);
  assert.equal(diff.has(99), false);
  assert.equal(diff.has(70000), false);
  assert.equal(diff.has(70099), false);
  assert.equal(diff.has(70100), true);

  // 只有一边有的桶：or 原样带过来，and 丢掉，xor 也要带过来
  const onlyLeft = bitmapOf(range(200000, 100));
  const mixed = bitmapOf(range(0, 50));
  assert.deepEqual(or(onlyLeft, mixed).containers(), [
    { key: 0, kind: 'array', count: 50 },
    { key: 3, kind: 'array', count: 100 },
  ]);
  assert.deepEqual(and(onlyLeft, mixed).containers(), []);
  assert.deepEqual(xor(onlyLeft, mixed).toArray(), [...range(0, 50), ...range(200000, 100)]);
});

test('equals 的口径', () => {
  assert.equal(equals(createBitmap(), createBitmap()), true);
  assert.equal(equals(bitmapOf([1, 2]), bitmapOf([2, 1, 1])), true);
  assert.equal(equals(bitmapOf([1, 2]), bitmapOf([1, 2, 3])), false);
  assert.equal(equals(bitmapOf([1, 2]), bitmapOf([1, 3])), false);
  assert.equal(equals(bitmapOf([70000]), bitmapOf([70001])), false);
  assert.equal(equals(bitmapOf([1]), createBitmap()), false);
  assert.equal(equals(bitmapOf(range(0, 5000)), bitmapOf(range(0, 5000))), true);
  assert.equal(equals(bitmapOf(range(0, 5000)), bitmapOf(range(0, 4999))), false);
  assert.equal(equals(or(bitmapOf([1, 2]), bitmapOf([2, 3])), bitmapOf([1, 2, 3])), true);
  assert.equal(equals(bitmapOf([1, 2, 3]), or(bitmapOf([1, 2]), bitmapOf([2, 3]))), true);
  assert.equal(code(() => equals(createBitmap(), null)), 'ERR_BAD_BITMAP');
  assert.equal(code(() => equals(createBitmap(), [1, 2])), 'ERR_BAD_BITMAP');
  assert.equal(code(() => and(createBitmap(), {})), 'ERR_BAD_BITMAP');
  assert.equal(code(() => or(null, createBitmap())), 'ERR_BAD_BITMAP');
  assert.equal(code(() => xor(createBitmap(), 7)), 'ERR_BAD_BITMAP');
});

test('和朴素集合实现逐项对比', () => {
  const valuesA = [];
  for (let bucket = 0; bucket < 6; bucket += 1) {
    for (let index = 0; index < 2000; index += 1) valuesA.push(bucket * 65536 + index * 3);
  }
  const valuesB = [];
  for (let index = 0; index < 6000; index += 1) valuesB.push(index * 2);

  const setA = new Set(valuesA);
  const setB = new Set(valuesB);
  const sortedA = [...setA].sort((x, y) => x - y);
  const sortedB = [...setB].sort((x, y) => x - y);

  const left = bitmapOf(shuffled(valuesA, 3));
  const right = bitmapOf(shuffled(valuesB, 11));
  assert.equal(left.size(), setA.size);
  assert.deepEqual(left.toArray(), sortedA);
  assert.equal(right.size(), setB.size);
  assert.deepEqual(right.toArray(), sortedB);

  const expected = (step) => {
    const out = new Set();
    for (const value of new Set([...setA, ...setB])) {
      const inA = setA.has(value);
      const inB = setB.has(value);
      const keep = step === 'and' ? inA && inB : step === 'or' ? inA || inB : inA !== inB;
      if (keep) out.add(value);
    }
    return [...out].sort((x, y) => x - y);
  };

  for (const [step, result] of [['and', and(left, right)], ['or', or(left, right)], ['xor', xor(left, right)]]) {
    const want = expected(step);
    assert.equal(result.size(), want.length, `${step} size`);
    assert.deepEqual(result.toArray(), want, step);
  }
  assert.equal(equals(or(left, right), or(right, left)), true);
  assert.equal(equals(and(left, right), and(right, left)), true);
  assert.equal(equals(xor(left, right), xor(right, left)), true);
  assert.equal(equals(left.clone(), left), true);
  // (A xor B) xor (A or B) 正好是 A and B
  assert.equal(equals(and(left, right), xor(xor(left, right), or(left, right))), true);
});
