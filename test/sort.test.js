import test from 'node:test';
import assert from 'node:assert/strict';

import { createSorter, DEFAULTS } from '../lib/extmerge.js';
import { byKey, cleanup, code, runsIn, shuffled, tempDir } from './util.js';

test('装得下就全在内存里排完，不落盘', (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  assert.equal(DEFAULTS.maxInMemory, 16);
  assert.equal(DEFAULTS.fanIn, 4);

  const sorter = createSorter({ compare: byKey, maxInMemory: 8, spillDir: dir });
  sorter.push({ key: 5 });
  sorter.push({ key: 1 });
  sorter.push({ key: 3 });
  assert.deepEqual(runsIn(dir), []);
  assert.deepEqual(sorter.finish().map((one) => one.key), [1, 3, 5]);
  assert.deepEqual(runsIn(dir), []);
  assert.deepEqual(sorter.stats(),
    { pushed: 3, spilled: 0, spilledRuns: 0, peakBuffered: 3, passes: 0 });
});

test('空着进来就是空着出去', (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const sorter = createSorter({ compare: byKey, spillDir: dir });
  assert.deepEqual(sorter.finish(), []);
  assert.deepEqual(runsIn(dir), []);
  assert.equal(sorter.stats().pushed, 0);
});

test('键一样的保持推进来的先后次序', (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const sorter = createSorter({ compare: byKey, maxInMemory: 2, spillDir: dir });
  sorter.push({ key: 1, tag: 'a' });
  sorter.push({ key: 2, tag: 'b' });
  sorter.push({ key: 1, tag: 'c' });
  sorter.push({ key: 2, tag: 'd' });
  sorter.push({ key: 1, tag: 'e' });
  assert.deepEqual(sorter.finish().map((one) => one.tag), ['a', 'c', 'e', 'b', 'd']);
});

test('条数远大于内存上限时结果跟整体排序一致', (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const keys = shuffled(300, 777);
  const sorter = createSorter({ compare: byKey, maxInMemory: 7, fanIn: 3, spillDir: dir });
  keys.forEach((key, seq) => sorter.push({ key, seq }));

  const back = sorter.finish();
  assert.equal(back.length, 300);
  assert.deepEqual(back.map((one) => one.key),
    Array.from({ length: 300 }, (_, index) => index));
  assert.deepEqual(back.map((one) => one.seq), shuffled(300, 777)
    .map((key, seq) => ({ key, seq }))
    .sort((left, right) => left.key - right.key)
    .map((one) => one.seq));
  assert.ok(sorter.stats().peakBuffered <= 7);
  assert.deepEqual(runsIn(dir), []);
});

test('路数超过 fanIn 就先归并几轮，轮数记在统计里', (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const sorter = createSorter({ compare: byKey, maxInMemory: 4, fanIn: 2, spillDir: dir });
  for (const key of shuffled(20, 99)) sorter.push({ key });
  // push 阶段落 5 个 run，归并要 3 轮（5 -> 3 -> 2 -> 1）
  assert.equal(runsIn(dir).length, 5);
  assert.deepEqual(sorter.finish().map((one) => one.key),
    Array.from({ length: 20 }, (_, index) => index));
  assert.equal(sorter.stats().passes, 3);
  assert.deepEqual(runsIn(dir), []);
});

test('compare 想怎么比就怎么比', (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const byLengthThenText = (left, right) => (right.length - left.length)
    || (left < right ? -1 : left > right ? 1 : 0);
  const sorter = createSorter({ compare: byLengthThenText, maxInMemory: 3, spillDir: dir });
  for (const word of ['pear', 'fig', 'apple', 'kiwi', 'plum', 'date', 'figs', 'a']) {
    sorter.push(word);
  }
  assert.deepEqual(sorter.finish(), ['apple', 'date', 'figs', 'kiwi', 'pear', 'plum', 'fig', 'a']);
  assert.equal(code(() => sorter.finish()), 'ERR_STATE');
});
