import test from 'node:test';
import assert from 'node:assert/strict';

import { createMatcher, scan } from '../lib/matchgrid.js';
import { code, fmt } from './util.js';

test('重叠的和同一处长短不同的都要报全，长的排前面', () => {
  const { matches, truncated } = scan(['a', 'aa', 'aaa'], 'aaaa');
  assert.deepEqual(matches.map(fmt), [
    'a@0+1',
    'aa@0+2', 'a@1+1',
    'aaa@0+3', 'aa@1+2', 'a@2+1',
    'aaa@1+3', 'aa@2+2', 'a@3+1',
  ]);
  assert.equal(truncated, false);
});

test('位置按码点算，emoji 和汉字都算一个', () => {
  assert.deepEqual(scan(['😀b', '中', 'b'], 'a😀b中').matches.map(fmt),
    ['😀b@1+2', 'b@2+1', '中@3+1']);
  // 换行算一个码点
  assert.deepEqual(scan(['b'], 'a\nb').matches.map(fmt), ['b@2+1']);
  assert.deepEqual(scan(['b'], 'a\r\nb').matches.map(fmt), ['b@3+1']);
});

test('ignoreCase 折完再比，报出来的还是原样的模式', () => {
  assert.deepEqual(scan(['Ab'], 'AB ab', { ignoreCase: true }).matches.map(fmt),
    ['Ab@0+2', 'Ab@3+2']);
  assert.deepEqual(scan(['Ab'], 'ab').matches, []);
  assert.equal(code(() => scan(['Ab', 'aB'], 'x', { ignoreCase: true })), 'ERR_BAD_PATTERNS');
  // 折完码点数会变的字符当它没折
  assert.deepEqual(scan(['İ'], 'İ').matches.map(fmt), ['İ@0+1']);
});

test('maxMatches 到了就截住，后面的全丢', () => {
  const capped = scan(['a'], 'aaaa', { maxMatches: 2 });
  assert.deepEqual(capped.matches.map(fmt), ['a@0+1', 'a@1+1']);
  assert.equal(capped.truncated, true);
  const loose = scan(['a'], 'aa');
  assert.deepEqual(loose.matches.map(fmt), ['a@0+1', 'a@1+1']);
  assert.equal(loose.truncated, false);
});

test('模式表存的是拷贝，外面改它不影响建好的自动机', () => {
  const patterns = ['ab', 'b'];
  const matcher = createMatcher(patterns);
  patterns.push('nope');
  assert.deepEqual(matcher.patterns, ['ab', 'b']);
  assert.deepEqual(matcher.scan('xab').matches.map(fmt), ['ab@1+2', 'b@2+1']);
  assert.deepEqual(matcher.scanner().push('ab').map(fmt), ['ab@0+2', 'b@1+1']);
});

test('模式和参数的问题各有各的码', () => {
  assert.equal(code(() => createMatcher('ab')), 'ERR_BAD_PATTERNS');
  assert.equal(code(() => createMatcher([])), 'ERR_BAD_PATTERNS');
  assert.equal(code(() => createMatcher([1])), 'ERR_BAD_PATTERNS');
  assert.equal(code(() => createMatcher([''])), 'ERR_BAD_PATTERNS');
  assert.equal(code(() => createMatcher(['ab', 'ab'])), 'ERR_BAD_PATTERNS');
  assert.equal(code(() => createMatcher(['ab'], null)), 'ERR_BAD_ARGS');
  assert.equal(code(() => createMatcher(['ab'], { ignoreCase: 'yes' })), 'ERR_BAD_ARGS');
  assert.equal(code(() => createMatcher(['ab'], { maxMatches: 0 })), 'ERR_BAD_ARGS');
  assert.equal(code(() => createMatcher(['ab'], { maxMatches: 1.5 })), 'ERR_BAD_ARGS');
  assert.equal(code(() => scan(['ab'], 3)), 'ERR_BAD_ARGS');
  assert.equal(code(() => scan(['ab'], 'ab', { maxMatches: '2' })), 'ERR_BAD_ARGS');
});
