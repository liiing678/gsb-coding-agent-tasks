import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createSorter } from '../lib/extmerge.js';
import { byKey, cleanup, code, linesIn, runsIn, shuffled, tempDir } from './util.js';

test('超了就落盘：文件名、每批条数与收尾清理都对得上', (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const sorter = createSorter({ compare: byKey, maxInMemory: 16, fanIn: 4, spillDir: dir });
  const keys = shuffled(100, 4242);
  keys.forEach((key, seq) => sorter.push({ key, seq }));

  assert.deepEqual(runsIn(dir),
    ['run-0001.jsonl', 'run-0002.jsonl', 'run-0003.jsonl', 'run-0004.jsonl',
      'run-0005.jsonl', 'run-0006.jsonl']);
  for (const name of runsIn(dir)) assert.equal(linesIn(dir, name).length, 16);

  const back = sorter.finish();
  assert.equal(back.length, 100);
  assert.deepEqual(back.map((one) => one.key), Array.from({ length: 100 }, (_, index) => index));
  assert.deepEqual(back.map((one) => one.seq), keys
    .map((key, seq) => ({ key, seq }))
    .sort((left, right) => left.key - right.key)
    .map((one) => one.seq));
  // 6 批 + 收尾那批 + 第一轮归并出来的 2 批
  assert.deepEqual(sorter.stats(),
    { pushed: 100, spilled: 200, spilledRuns: 9, peakBuffered: 16, passes: 2 });
  assert.deepEqual(runsIn(dir), []);
});

test('溢出文件是一行一条 JSON，序号跟在内存里的次序一致', (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const sorter = createSorter({ compare: byKey, maxInMemory: 3, spillDir: dir });
  sorter.push({ key: 3, tag: 'c' });
  sorter.push({ key: 1, tag: 'a' });
  sorter.push({ key: 2, tag: 'b' });

  const lines = linesIn(dir, 'run-0001.jsonl');
  // 落盘的时候这一批已经排好了序：key 1、2、3 分别是第 2、3、1 条推进来的
  assert.deepEqual(lines.map((line) => JSON.parse(line)),
    [{ seq: 1, item: { key: 1, tag: 'a' } },
      { seq: 2, item: { key: 2, tag: 'b' } },
      { seq: 0, item: { key: 3, tag: 'c' } }]);
  const raw = fs.readFileSync(path.join(dir, 'run-0001.jsonl'), 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.equal(raw.split('\n').length - 1, 3);
  assert.deepEqual(sorter.finish().map((one) => one.tag), ['a', 'b', 'c']);
});

test('配置不对是 ERR_BAD_CONFIG', (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'not-a-dir.txt');
  fs.writeFileSync(file, 'x');

  assert.equal(code(() => createSorter()), 'ERR_BAD_CONFIG');
  assert.equal(code(() => createSorter({ compare: 'key', spillDir: dir })), 'ERR_BAD_CONFIG');
  assert.equal(code(() => createSorter({ compare: byKey, spillDir: dir, maxInMemory: 0 })),
    'ERR_BAD_CONFIG');
  assert.equal(code(() => createSorter({ compare: byKey, spillDir: dir, maxInMemory: 1.5 })),
    'ERR_BAD_CONFIG');
  assert.equal(code(() => createSorter({ compare: byKey, spillDir: dir, fanIn: 1 })),
    'ERR_BAD_CONFIG');
  assert.equal(code(() => createSorter({ compare: byKey, spillDir: '' })), 'ERR_BAD_CONFIG');
  assert.equal(code(() => createSorter({ compare: byKey, spillDir: path.join(dir, 'nope') })),
    'ERR_BAD_CONFIG');
  assert.equal(code(() => createSorter({ compare: byKey, spillDir: file })), 'ERR_BAD_CONFIG');
});

test('收过尾之后不能再动', (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const sorter = createSorter({ compare: byKey, maxInMemory: 2, spillDir: dir });
  sorter.push({ key: 2 });
  sorter.finish();
  assert.equal(code(() => sorter.push({ key: 1 })), 'ERR_STATE');
  assert.equal(code(() => sorter.finish()), 'ERR_STATE');
  assert.deepEqual(runsIn(dir), []);
});

test('塞不进 JSON 的东西当场拦住', (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const sorter = createSorter({ compare: byKey, maxInMemory: 2, spillDir: dir });
  assert.equal(code(() => sorter.push(undefined)), 'ERR_BAD_VALUE');
  assert.equal(code(() => sorter.push(() => {})), 'ERR_BAD_VALUE');
  assert.equal(code(() => sorter.push(1n)), 'ERR_BAD_VALUE');
  assert.equal(sorter.stats().pushed, 0);
  sorter.push({ key: 1 });
  assert.deepEqual(sorter.finish().map((one) => one.key), [1]);
});
