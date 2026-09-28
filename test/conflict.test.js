import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeThreeWay } from '../lib/merge.js';
import { joinLines } from '../lib/lines.js';

const text = (...lines) => joinLines(lines);

test('同一行两边改成不同的内容，按 diff3 布局标出来', () => {
  const out = mergeThreeWay(
    text('a', 'port=8080', 'b'),
    text('a', 'port=9090', 'b'),
    text('a', 'port=7070', 'b'),
  );
  assert.equal(
    out.text,
    text(
      'a',
      '<<<<<<< ours',
      'port=9090',
      '||||||| base',
      'port=8080',
      '=======',
      'port=7070',
      '>>>>>>> theirs',
      'b',
    ),
  );
  assert.equal(out.clean, false);
  assert.equal(out.stats.conflicts, 1);
  assert.equal(out.stats.segments, 1);
});

test('紧挨着的两处改动中间没有公共行，算同一段，互相顶就是冲突', () => {
  const out = mergeThreeWay(
    text('a', 'b', 'c', 'd'),
    text('a', 'B', 'c', 'd'),
    text('a', 'b', 'C', 'd'),
  );
  assert.equal(out.stats.segments, 1);
  assert.equal(out.stats.conflicts, 1);
  assert.equal(
    out.text,
    text(
      'a',
      '<<<<<<< ours',
      'B',
      'c',
      '||||||| base',
      'b',
      'c',
      '=======',
      'b',
      'C',
      '>>>>>>> theirs',
      'd',
    ),
  );
});

test('一边删一边改，被删的那行留在 base 段里', () => {
  const out = mergeThreeWay(text('x', 'y', 'z'), text('x', 'z'), text('x', 'Y', 'z'));
  assert.equal(
    out.text,
    text('x', '<<<<<<< ours', '||||||| base', 'y', '=======', 'Y', '>>>>>>> theirs', 'z'),
  );
  assert.equal(out.stats.conflicts, 1);
});

test('两边都删掉同一行，是干净的删除', () => {
  const out = mergeThreeWay(text('x', 'y', 'z'), text('x', 'z'), text('x', 'z'));
  assert.equal(out.text, text('x', 'z'));
  assert.equal(out.clean, true);
  assert.equal(out.stats.conflicts, 0);
});

test('merge 布局只留两边，没有 base 段', () => {
  const out = mergeThreeWay(text('a', 'b'), text('a', 'ours'), text('a', 'theirs'), {
    markerLayout: 'merge',
  });
  assert.equal(out.text, text('a', '<<<<<<< ours', 'ours', '=======', 'theirs', '>>>>>>> theirs'));
});

test('冲突条目里的行号和行数能对上', () => {
  const out = mergeThreeWay(
    text('a', 'b', 'c', 'd', 'e'),
    text('a', 'B', 'c', 'd', 'e'),
    text('a', 'b', 'c', 'D', 'e'),
  );
  assert.equal(out.conflicts.length, 0);

  const two = mergeThreeWay(
    text('a', 'b', 'c', 'd', 'e'),
    text('a', 'B', 'c', 'D', 'e'),
    text('a', 'BB', 'c', 'DD', 'e'),
  );
  assert.equal(two.conflicts.length, 2);
  assert.deepEqual(
    two.conflicts.map((c) => c.index),
    [1, 2],
  );
  const lines = two.text.split('\n');
  for (const conflict of two.conflicts) {
    assert.equal(lines[conflict.outputLine - 1], '<<<<<<< ours');
    assert.equal(conflict.oursCount, 1);
    assert.equal(conflict.theirsCount, 1);
    assert.equal(conflict.baseCount, 1);
  }
  assert.deepEqual(
    two.conflicts.map((c) => c.outputLine),
    [2, 10],
  );
  assert.equal(lines[7], '>>>>>>> theirs');
  assert.equal(lines[15], '>>>>>>> theirs');
});

test('标签可以换，标记行跟着换', () => {
  const out = mergeThreeWay(text('a', 'b'), text('a', 'ours'), text('a', 'theirs'), {
    oursLabel: 'feature/login',
    baseLabel: 'main',
    theirsLabel: 'release/2.1',
  });
  const lines = out.text.split('\n');
  assert.equal(lines[1], '<<<<<<< feature/login');
  assert.equal(lines[3], '||||||| main');
  assert.equal(lines[5], '=======');
  assert.equal(lines[7], '>>>>>>> release/2.1');
});
