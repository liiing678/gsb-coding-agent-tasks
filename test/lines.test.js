import test from 'node:test';
import assert from 'node:assert/strict';

import { code } from './util.js';
import { createBuffer } from '../lib/pagetable.js';

test('分行：以 \\n 切，结尾的换行算一个空行', () => {
  const buf = createBuffer('one\ntwo\n');
  assert.equal(buf.lineCount(), 3);
  assert.equal(buf.lineAt(0), 'one');
  assert.equal(buf.lineAt(1), 'two');
  assert.equal(buf.lineAt(2), '');
  assert.equal(createBuffer('').lineCount(), 1);
  assert.equal(createBuffer('\n\n').lineCount(), 3);
  assert.equal(code(() => buf.lineAt(3)), 'ERR_OUT_OF_RANGE');
  assert.equal(code(() => buf.lineAt(-1)), 'ERR_BAD_ARGUMENT');
});

test('positionAt：行号加列号都是 0 基', () => {
  const buf = createBuffer('one\ntwo\n');
  assert.deepEqual(buf.positionAt(0), { line: 0, column: 0 });
  assert.deepEqual(buf.positionAt(3), { line: 0, column: 3 });
  assert.deepEqual(buf.positionAt(4), { line: 1, column: 0 });
  assert.deepEqual(buf.positionAt(7), { line: 1, column: 3 });
  assert.deepEqual(buf.positionAt(8), { line: 2, column: 0 });
  assert.equal(code(() => buf.positionAt(9)), 'ERR_OUT_OF_RANGE');
  assert.equal(code(() => buf.positionAt(1.5)), 'ERR_BAD_ARGUMENT');
});

test('offsetAt 与 positionAt 对得上', () => {
  const buf = createBuffer('one\ntwo\n');
  assert.equal(buf.offsetAt(0, 0), 0);
  assert.equal(buf.offsetAt(0, 3), 3);
  assert.equal(buf.offsetAt(1, 0), 4);
  assert.equal(buf.offsetAt(1, 3), 7);
  assert.equal(buf.offsetAt(2, 0), 8);
  assert.equal(code(() => buf.offsetAt(1, 4)), 'ERR_OUT_OF_RANGE');
  assert.equal(code(() => buf.offsetAt(3, 0)), 'ERR_OUT_OF_RANGE');
  assert.equal(code(() => buf.offsetAt(0, -1)), 'ERR_BAD_ARGUMENT');
  const edits = createBuffer('a\nb');
  edits.insert(2, 'cc');
  assert.deepEqual(edits.positionAt(4), { line: 1, column: 2 });
  assert.equal(edits.offsetAt(1, 2), 4);
});

test('撤销重做：栈的深度和顺序都对得上，新修改清空重做栈', () => {
  const buf = createBuffer('abc');
  buf.insert(3, 'd');
  buf.insert(4, 'e');
  assert.equal(buf.text(), 'abcde');
  assert.deepEqual([buf.stats().undoDepth, buf.stats().redoDepth], [2, 0]);
  assert.equal(buf.undo(), true);
  assert.equal(buf.text(), 'abcd');
  assert.deepEqual([buf.stats().undoDepth, buf.stats().redoDepth], [1, 1]);
  assert.equal(buf.undo(), true);
  assert.equal(buf.text(), 'abc');
  assert.equal(buf.undo(), false);
  assert.equal(buf.redo(), true);
  assert.equal(buf.redo(), true);
  assert.equal(buf.text(), 'abcde');
  assert.equal(buf.redo(), false);
  buf.undo();
  buf.insert(0, 'Z');
  assert.equal(buf.text(), 'Zabcd');
  assert.equal(buf.redo(), false);
  assert.equal(buf.stats().redoDepth, 0);
});

test('事务：一整段合成一步撤销', () => {
  const buf = createBuffer('abc');
  buf.transaction(() => {
    buf.insert(3, 'd');
    buf.delete(0, 1);
    buf.insert(0, '>');
  });
  assert.equal(buf.text(), '>bcd');
  assert.equal(buf.stats().undoDepth, 1);
  assert.equal(buf.transaction(() => {}), undefined);
  assert.equal(buf.stats().undoDepth, 1);
  assert.equal(buf.undo(), true);
  assert.equal(buf.text(), 'abc');
});

test('事务里抛错就整体回滚，嵌套事务报错', () => {
  const buf = createBuffer('abc');
  assert.throws(() => buf.transaction(() => {
    buf.insert(0, 'X');
    buf.delete(0, 1);
    throw new Error('boom');
  }), /boom/);
  assert.equal(buf.text(), 'abc');
  assert.deepEqual(buf.stats().undoDepth, 0);
  assert.equal(code(() => buf.transaction(() => buf.transaction(() => {}))), 'ERR_NESTED_TRANSACTION');
  assert.equal(buf.text(), 'abc');
  const after = createBuffer('abc');
  after.transaction(() => {
    after.insert(0, 'X');
    assert.equal(after.text(), 'Xabc');
  });
  assert.equal(after.undo(), true);
  assert.equal(after.text(), 'abc');
});
