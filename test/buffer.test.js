import test from 'node:test';
import assert from 'node:assert/strict';

import { code } from './util.js';
import { createBuffer } from '../lib/pagetable.js';

test('初始内容：text / length / slice', () => {
  const buf = createBuffer('hello world');
  assert.equal(buf.text(), 'hello world');
  assert.equal(buf.length(), 11);
  assert.equal(buf.slice(0, 5), 'hello');
  assert.equal(buf.slice(6, 5), 'world');
  assert.equal(buf.slice(11, 0), '');
  assert.deepEqual(buf.stats(), {
    length: 11, lines: 1, pieces: 1, addLength: 0, undoDepth: 0, redoDepth: 0,
  });
  assert.deepEqual(createBuffer().stats(), {
    length: 0, lines: 1, pieces: 0, addLength: 0, undoDepth: 0, redoDepth: 0,
  });
});

test('插入不复制原文：中间插一段就是切开原块再加一块', () => {
  const buf = createBuffer('hello world');
  buf.insert(5, ',');
  assert.equal(buf.text(), 'hello, world');
  assert.equal(buf.stats().pieces, 3);
  assert.equal(buf.stats().addLength, 1);
  buf.insert(0, '> ');
  assert.equal(buf.text(), '> hello, world');
  assert.equal(buf.stats().pieces, 4);
  assert.equal(buf.stats().addLength, 3);
  buf.insert(3, '');
  assert.equal(buf.stats().undoDepth, 2);
  buf.insert(buf.length(), '!');
  assert.equal(buf.text(), '> hello, world!');
});

test('删除：跨块删掉、剩下的块接回去', () => {
  const buf = createBuffer('abcdefgh');
  buf.insert(4, 'XY');
  assert.equal(buf.text(), 'abcdXYefgh');
  assert.equal(buf.stats().pieces, 3);
  buf.delete(4, 2);
  assert.equal(buf.text(), 'abcdefgh');
  assert.equal(buf.stats().pieces, 1);
  buf.delete(0, 0);
  assert.equal(buf.stats().undoDepth, 2);
  buf.delete(7, 1);
  assert.equal(buf.text(), 'abcdefg');
  assert.equal(buf.stats().pieces, 1);
  buf.insert(3, 'ZZ');
  assert.equal(buf.text(), 'abcZZdefg');
  assert.equal(buf.stats().pieces, 3);
  buf.delete(3, 4);
  assert.equal(buf.text(), 'abcfg');
  assert.equal(buf.stats().pieces, 2);
});

test('replace 只算一步撤销', () => {
  const buf = createBuffer('abcdef');
  buf.insert(0, 'X');
  buf.replace(1, 3, 'YZ');
  assert.equal(buf.text(), 'XYZdef');
  assert.equal(buf.stats().undoDepth, 2);
  assert.equal(buf.undo(), true);
  assert.equal(buf.text(), 'Xabcdef');
  assert.equal(buf.undo(), true);
  assert.equal(buf.text(), 'abcdef');
  assert.equal(buf.undo(), false);
  assert.equal(buf.stats().pieces, 1);
});

test('相邻同段会合并', () => {
  const buf = createBuffer('ab');
  buf.insert(1, 'X');
  assert.equal(buf.stats().pieces, 3);
  buf.delete(1, 1);
  assert.equal(buf.text(), 'ab');
  assert.equal(buf.stats().pieces, 1);
});

test('参数与越界各报各的码', () => {
  const buf = createBuffer('hello');
  assert.equal(code(() => createBuffer(5)), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => buf.insert(-1, 'x')), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => buf.insert(1.5, 'x')), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => buf.insert(0, 5)), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => buf.insert(6, 'x')), 'ERR_OUT_OF_RANGE');
  assert.equal(code(() => buf.delete(0, 6)), 'ERR_OUT_OF_RANGE');
  assert.equal(code(() => buf.delete(5, 1)), 'ERR_OUT_OF_RANGE');
  assert.equal(code(() => buf.slice(0, 6)), 'ERR_OUT_OF_RANGE');
  assert.equal(code(() => buf.slice(-1, 1)), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => buf.replace(4, 2, 'z')), 'ERR_OUT_OF_RANGE');
  assert.equal(code(() => buf.replace(0, 0, 5)), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => buf.insert(5, 'x')), null);
});
