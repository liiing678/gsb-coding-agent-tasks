import test from 'node:test';
import assert from 'node:assert/strict';

import { clip, displayWidth, wrap } from '../lib/wrapfold.js';
import { code, texts } from './util.js';

test('英文按空格断，行尾空格吃掉，缩进算在宽度里', () => {
  const plain = wrap('the quick brown fox jumps', { width: 10 });
  assert.deepEqual(texts(plain), ['the quick', 'brown fox', 'jumps']);
  assert.deepEqual(plain.lines.map((line) => line.width), [9, 9, 5]);
  assert.equal(plain.overflow, 0);

  const indented = wrap('the quick brown fox', { width: 12, indent: '>>', hangingIndent: '>>>>' });
  assert.deepEqual(texts(indented), ['>>the quick', '>>>>brown', '>>>>fox']);
  assert.deepEqual(indented.lines.map((line) => line.width), [11, 9, 7]);
  assert.equal(indented.overflow, 0);
});

test('汉字之间可以断', () => {
  const result = wrap('折行的时候汉字之间可以断开', { width: 8 });
  assert.deepEqual(texts(result), ['折行的时', '候汉字之', '间可以断', '开']);
  assert.deepEqual(result.lines.map((line) => line.width), [8, 8, 8, 2]);
  assert.equal(result.overflow, 0);
});

test('连字符之后能断，连字符留在上一行', () => {
  const result = wrap('state-of-the-art tooling', { width: 12 });
  assert.deepEqual(texts(result).slice(0, 2), ['state-of-', 'the-art']);
  assert.equal(result.overflow, 0);
});

test('禁则：收尾标点拽回上一行，开括号推到下一行', () => {
  const trailing = wrap('abcd ，efg', { width: 9 });
  assert.deepEqual(texts(trailing), ['abcd ，', 'efg']);
  assert.equal(trailing.overflow, 0);

  const opening = wrap('abc(defg', { width: 4, breakLongWords: true });
  assert.deepEqual(texts(opening), ['abc', '(def', 'g']);
});

test('断不了的整块：默认自己占一行，开了硬断就按字素簇切', () => {
  const whole = wrap('supercalifragilistic', { width: 6 });
  assert.deepEqual(whole.lines, [{ text: 'supercalifragilistic', width: 20 }]);
  assert.equal(whole.overflow, 1);

  const hard = wrap('supercalifragilistic', { width: 6, breakLongWords: true });
  assert.deepEqual(texts(hard), ['superc', 'alifra', 'gilist', 'ic']);
  assert.equal(hard.overflow, 0);
});

test('段落按换行切开，空段也要出一行', () => {
  const result = wrap('a\r\nb\rc\n\n d', { width: 10 });
  assert.deepEqual(texts(result), ['a', 'b', 'c', '', ' d']);
  assert.deepEqual(result.lines.map((line) => line.width), [1, 1, 1, 0, 2]);

  const lonely = wrap('', { width: 4, indent: '--' });
  assert.deepEqual(lonely.lines, [{ text: '--', width: 2 }]);
});

test('参数不对一律 ERR_BAD_ARGS', () => {
  assert.equal(code(() => wrap(7)), 'ERR_BAD_ARGS');
  assert.equal(code(() => wrap('x', null)), 'ERR_BAD_ARGS');
  assert.equal(code(() => wrap('x', { width: 0 })), 'ERR_BAD_ARGS');
  assert.equal(code(() => wrap('x', { width: 1.5 })), 'ERR_BAD_ARGS');
  assert.equal(code(() => wrap('x', { indent: 7 })), 'ERR_BAD_ARGS');
  assert.equal(code(() => wrap('x', { width: 2, indent: '中' })), 'ERR_BAD_ARGS');
  assert.equal(code(() => wrap('x', { width: 2, hangingIndent: '中' })), 'ERR_BAD_ARGS');
  assert.equal(code(() => wrap('x', { breakLongWords: 'yes' })), 'ERR_BAD_ARGS');
});

test('硬断按字素簇，组合记号不跟基字符分开', () => {
  const result = wrap('a\u0301'.repeat(5), { width: 3, breakLongWords: true });
  assert.deepEqual(texts(result), ['a\u0301a\u0301a\u0301', 'a\u0301a\u0301']);
  assert.equal(result.overflow, 0);
});

test('clip 按宽度截断，省略号也算宽度', () => {
  assert.deepEqual(clip('abc', 5), { text: 'abc', width: 3, clipped: false });
  assert.deepEqual(clip('这是一句很长的话', 7), { text: '这是一…', width: 7, clipped: true });
  assert.deepEqual(clip('中文字', 3), { text: '中…', width: 3, clipped: true });
  assert.deepEqual(clip('中文字', 2), { text: '…', width: 1, clipped: true });
  assert.deepEqual(clip('ab', 1), { text: '…', width: 1, clipped: true });
  assert.deepEqual(clip('ab', 1, '...'), { text: '', width: 0, clipped: true });
  assert.equal(code(() => clip('a', 0)), 'ERR_BAD_ARGS');
  assert.equal(code(() => clip('a', 2, 7)), 'ERR_BAD_ARGS');
});

test('没超宽的行 overflow 就是 0，每行的宽度对得上', () => {
  const text = '把这句话折成宽度十二的几行';
  const result = wrap(text, { width: 12 });
  assert.equal(result.overflow, 0);
  for (const line of result.lines) {
    assert.equal(line.width, displayWidth(line.text));
    assert.ok(line.width <= 12);
  }
  assert.equal(texts(result).join(''), text);
});
