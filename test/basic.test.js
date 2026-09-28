import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeThreeWay } from '../lib/merge.js';
import { joinLines } from '../lib/lines.js';

const text = (...lines) => joinLines(lines);

test('两边都没动，原样返回', () => {
  const base = 'a\nb\nc\n';
  const out = mergeThreeWay(base, base, base);
  assert.equal(out.text, base);
  assert.equal(out.clean, true);
  assert.deepEqual(out.conflicts, []);
  assert.equal(out.stats.segments, 0);
  assert.equal(out.stats.addedLines, 0);
  assert.equal(out.stats.removedLines, 0);
});

test('只有我们这边改了一行（替换算一增一删）', () => {
  const out = mergeThreeWay(text('a', 'b', 'c'), text('a', 'B', 'c'), text('a', 'b', 'c'));
  assert.equal(out.text, text('a', 'B', 'c'));
  assert.equal(out.clean, true);
  assert.equal(out.stats.segments, 1);
  assert.equal(out.stats.conflicts, 0);
  assert.equal(out.stats.addedLines, 1);
  assert.equal(out.stats.removedLines, 1);
});

test('只有他们那边删了一行，并记到统计里', () => {
  const out = mergeThreeWay(text('a', 'b', 'c'), text('a', 'b', 'c'), text('a', 'c'));
  assert.equal(out.text, text('a', 'c'));
  assert.equal(out.clean, true);
  assert.deepEqual(out.stats, { segments: 1, conflicts: 0, addedLines: 0, removedLines: 1 });
});

test('两处改动中间隔着一行公共行，各算一段', () => {
  const base = text('a', 'b', 'c', 'd', 'e');
  const ours = text('a', 'B', 'c', 'd', 'e');
  const theirs = text('a', 'b', 'c', 'D', 'e');
  const out = mergeThreeWay(base, ours, theirs);
  assert.equal(out.text, text('a', 'B', 'c', 'D', 'e'));
  assert.equal(out.stats.segments, 2);
  assert.equal(out.stats.conflicts, 0);
});

test('两边在不同位置各插一行，都是干净的', () => {
  const base = text('a', 'b', 'c');
  const ours = text('a', 'a2', 'b', 'c');
  const theirs = text('a', 'b', 'c', 'c2');
  const out = mergeThreeWay(base, ours, theirs);
  assert.equal(out.text, text('a', 'a2', 'b', 'c', 'c2'));
  assert.equal(out.clean, true);
  assert.equal(out.stats.addedLines, 2);
  assert.equal(out.stats.segments, 2);
});

test('CRLF 的输入按 LF 输出，行尾的 \\r 在比较时不算差异', () => {
  const base = 'a\r\nb\r\nc\r\n';
  const ours = 'a\r\nB\r\nc\r\n';
  const theirs = 'a\nb\nc\n';
  const out = mergeThreeWay(base, ours, theirs);
  assert.equal(out.text, 'a\nB\nc\n');
  assert.equal(out.text.includes('\r'), false);
  assert.equal(out.clean, true);
  assert.equal(out.stats.segments, 1);
});

test('两边改成一样的不算冲突', () => {
  const base = text('a', 'b', 'c');
  const ours = text('a', 'B', 'c');
  const theirs = text('a', 'B', 'c');
  const out = mergeThreeWay(base, ours, theirs);
  assert.equal(out.text, text('a', 'B', 'c'));
  assert.equal(out.clean, true);
  assert.equal(out.stats.conflicts, 0);
});
