import test from 'node:test';
import assert from 'node:assert/strict';

import { createBitmap, equals } from '../lib/roarbit.js';
import { bitmapOf, code, range, shuffled } from './util.js';

test('add / has / size 的返回值口径', () => {
  const bitmap = createBitmap();
  assert.equal(bitmap.size(), 0);
  assert.deepEqual(bitmap.toArray(), []);
  assert.deepEqual(bitmap.containers(), []);

  assert.equal(bitmap.add(5), true);
  assert.equal(bitmap.add(5), false);
  assert.equal(bitmap.add(5), false);
  assert.equal(bitmap.size(), 1);
  assert.equal(bitmap.has(5), true);
  assert.equal(bitmap.has(6), false);
  assert.equal(bitmap.has(0), false);

  assert.equal(bitmap.remove(6), false);
  assert.equal(bitmap.remove(5), true);
  assert.equal(bitmap.remove(5), false);
  assert.equal(bitmap.size(), 0);
  assert.equal(bitmap.has(5), false);
  assert.deepEqual(bitmap.containers(), []);
});

test('toArray 升序、不丢值，高位的值也要对', () => {
  const bitmap = createBitmap();
  for (const value of [65535, 0, 65536, 4294967295, 32768, 2147483648, 1]) bitmap.add(value);
  assert.deepEqual(bitmap.toArray(), [0, 1, 32768, 65535, 65536, 2147483648, 4294967295]);
  assert.equal(bitmap.size(), 7);

  const three = bitmapOf([10, 20, 30]);
  assert.deepEqual(three.toArray(), [10, 20, 30]);
  assert.equal(three.size(), 3);

  const wide = bitmapOf(range(1000, 5000));
  assert.deepEqual(wide.toArray(), range(1000, 5000));
  assert.equal(wide.size(), 5000);
});

test('位图容器里的 has / size / toArray 要对得上', () => {
  const values = range(0, 5000);
  const bitmap = bitmapOf(values);
  assert.deepEqual(bitmap.containers(), [{ key: 0, kind: 'bitmap', count: 5000 }]);
  assert.equal(bitmap.size(), 5000);
  for (const value of [0, 1, 31, 32, 33, 63, 64, 4095, 4096, 4999]) {
    assert.equal(bitmap.has(value), true, `has(${value})`);
  }
  for (const value of [5000, 6000, 65535]) {
    assert.equal(bitmap.has(value), false, `has(${value})`);
  }
  assert.deepEqual(bitmap.toArray(), values);
  assert.equal(bitmap.remove(4999), true);
  assert.equal(bitmap.has(4999), false);
  assert.equal(bitmap.size(), 4999);
});

test('低位落在高半区的位图容器也不能丢点', () => {
  const high = bitmapOf(range(40000, 5000));
  assert.deepEqual(high.containers(), [{ key: 0, kind: 'bitmap', count: 5000 }]);
  assert.equal(high.size(), 5000);
  assert.equal(high.has(40000), true);
  assert.equal(high.has(44999), true);
  assert.equal(high.has(45000), false);
  assert.deepEqual(high.toArray(), range(40000, 5000));
});

test('稀疏的位图容器：has 要按低 16 位来定位', () => {
  const sparseValues = range(0, 4097, 15);
  const sparse = bitmapOf(sparseValues);
  assert.equal(sparse.containers()[0].kind, 'bitmap');
  assert.equal(sparse.size(), 4097);
  for (const value of [0, 15, 1500, 61440]) assert.equal(sparse.has(value), true, `has(${value})`);
  for (const value of [1, 14, 1499, 61439]) assert.equal(sparse.has(value), false, `has(${value})`);
  assert.deepEqual(sparse.toArray(), sparseValues);

  assert.equal(sparse.remove(15), true);
  assert.equal(sparse.has(15), false);
  assert.equal(sparse.size(), 4096);
  assert.equal(sparse.remove(15), false);
  assert.deepEqual(sparse.toArray(), sparseValues.filter((value) => value !== 15));
  assert.equal(sparse.has(61440), true);
});

test('容器类型的判定：4096 个还是数组，4097 个才换位图', () => {
  const four = bitmapOf(range(0, 4096));
  assert.equal(four.size(), 4096);
  assert.deepEqual(four.containers(), [{ key: 0, kind: 'array', count: 4096 }]);
  assert.equal(four.has(4095), true);

  const five = bitmapOf(range(0, 4097));
  assert.equal(five.size(), 4097);
  assert.deepEqual(five.containers(), [{ key: 0, kind: 'bitmap', count: 4097 }]);
  assert.deepEqual(five.toArray(), range(0, 4097));

  const mixed = bitmapOf(shuffled(range(0, 4097), 7));
  assert.deepEqual(mixed.containers(), [{ key: 0, kind: 'bitmap', count: 4097 }]);
  assert.deepEqual(mixed.toArray(), range(0, 4097));

  const perBucket = bitmapOf([...range(0, 4096), ...range(65536, 4096)]);
  assert.deepEqual(perBucket.containers(), [
    { key: 0, kind: 'array', count: 4096 },
    { key: 1, kind: 'array', count: 4096 },
  ]);
});

test('位图容器掉到 4096 个就换回数组', () => {
  const bitmap = bitmapOf(range(0, 5000));
  assert.equal(bitmap.containers()[0].kind, 'bitmap');
  for (const value of range(4000, 1000)) assert.equal(bitmap.remove(value), true, `remove(${value})`);
  assert.equal(bitmap.size(), 4000);
  assert.deepEqual(bitmap.containers(), [{ key: 0, kind: 'array', count: 4000 }]);
  assert.deepEqual(bitmap.toArray(), range(0, 4000));
  assert.equal(bitmap.has(3999), true);
  assert.equal(bitmap.has(4000), false);
});

test('删空之后桶要整个不留，clone 是深拷贝', () => {
  const bitmap = bitmapOf([1, 2, 3, 70000]);
  assert.deepEqual(bitmap.containers(), [
    { key: 0, kind: 'array', count: 3 },
    { key: 1, kind: 'array', count: 1 },
  ]);
  for (const value of [1, 2, 3]) assert.equal(bitmap.remove(value), true);
  assert.deepEqual(bitmap.containers(), [{ key: 1, kind: 'array', count: 1 }]);
  assert.deepEqual(bitmap.toArray(), [70000]);

  const copy = bitmap.clone();
  copy.add(9);
  assert.equal(equals(copy, bitmap), false);
  assert.equal(copy.has(9), true);
  assert.equal(bitmap.has(9), false);

  for (const value of [70000, 9]) copy.remove(value);
  assert.equal(copy.size(), 0);
  assert.deepEqual(copy.containers(), []);
});

test('值域与参数错误', () => {
  const bitmap = createBitmap();
  assert.equal(code(() => bitmap.add(-1)), 'ERR_BAD_VALUE');
  assert.equal(code(() => bitmap.add(4294967296)), 'ERR_BAD_VALUE');
  assert.equal(code(() => bitmap.add(1.5)), 'ERR_BAD_VALUE');
  assert.equal(code(() => bitmap.add('1')), 'ERR_BAD_VALUE');
  assert.equal(code(() => bitmap.add(NaN)), 'ERR_BAD_VALUE');
  assert.equal(code(() => bitmap.remove(-1)), 'ERR_BAD_VALUE');
  assert.equal(code(() => bitmap.has(2 ** 32)), 'ERR_BAD_VALUE');

  assert.equal(bitmap.add(0), true);
  assert.equal(bitmap.add(4294967295), true);
  assert.equal(bitmap.has(4294967295), true);
  assert.equal(bitmap.size(), 2);
});
