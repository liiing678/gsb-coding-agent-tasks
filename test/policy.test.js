import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeThreeWay, MAX_LINES } from '../lib/merge.js';
import { joinLines } from '../lib/lines.js';

const text = (...lines) => joinLines(lines);

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'MergeError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

test("conflictStyle 给 ours，冲突段直接取我们这边的", () => {
  const out = mergeThreeWay(text('a', 'b'), text('a', 'ours'), text('a', 'theirs'), {
    conflictStyle: 'ours',
  });
  assert.equal(out.text, text('a', 'ours'));
  assert.equal(out.text.includes('<<<<<<<'), false);
  assert.equal(out.stats.conflicts, 1);
  assert.equal(out.clean, false);
});

test("conflictStyle 给 theirs，冲突段直接取他们那边的", () => {
  const out = mergeThreeWay(text('a', 'b'), text('a', 'ours'), text('a', 'theirs'), {
    conflictStyle: 'theirs',
  });
  assert.equal(out.text, text('a', 'theirs'));
  assert.equal(out.stats.conflicts, 1);
});

test('conflictStyle 给 union，两边的行都留着，完全一样的行不重复', () => {
  const out = mergeThreeWay(
    text('a', 'x', 'y'),
    text('a', 'X', 'y'),
    text('a', 'XX', 'y'),
    { conflictStyle: 'union' },
  );
  assert.equal(out.text, text('a', 'X', 'XX', 'y'));
  assert.equal(out.text.includes('<<<<<<<'), false);
  assert.equal(out.stats.conflicts, 1);
});

test('参数不是字符串直接报 ERR_BAD_INPUT', () => {
  expectError(() => mergeThreeWay(null, 'a', 'a'), 'ERR_BAD_INPUT');
  const err = expectError(() => mergeThreeWay('a', 'a', undefined), 'ERR_BAD_INPUT');
  assert.equal(err.details.field, 'theirs');
});

test('不认识的 conflictStyle / markerLayout 报 ERR_BAD_OPTION', () => {
  expectError(() => mergeThreeWay('a', 'a', 'a', { conflictStyle: 'fast' }), 'ERR_BAD_OPTION');
  expectError(() => mergeThreeWay('a', 'a', 'a', { markerLayout: 'git' }), 'ERR_BAD_OPTION');
});

test('单边超过行数上限报 ERR_TOO_MANY_LINES', () => {
  const huge = Array.from({ length: MAX_LINES + 1 }, (_, i) => `line-${i}`).join('\n');
  const err = expectError(() => mergeThreeWay('a', huge, 'a'), 'ERR_TOO_MANY_LINES');
  assert.equal(err.details.lines, MAX_LINES + 1);
  assert.equal(err.details.max, MAX_LINES);
});

test('一万多行的文件里有两处改动，也要算得对', () => {
  const lines = Array.from({ length: 12000 }, (_, i) => `line-${i}`);
  const ours = [...lines];
  const theirs = [...lines];
  ours[3000] = 'line-3000-ours';
  theirs[9000] = 'line-9000-theirs';
  const out = mergeThreeWay(joinLines(lines), joinLines(ours), joinLines(theirs));
  const result = out.text.split('\n');
  assert.equal(result.length, 12000);
  assert.equal(result[3000], 'line-3000-ours');
  assert.equal(result[9000], 'line-9000-theirs');
  assert.equal(out.clean, true);
  assert.equal(out.stats.segments, 2);
});
