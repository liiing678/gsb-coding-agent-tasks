import test from 'node:test';
import assert from 'node:assert/strict';

import { formatPointer, get, parsePointer } from '../lib/jsonpatch.js';
import { code } from './util.js';

test('指针的解析和拼回来', () => {
  assert.deepEqual(parsePointer(''), []);
  assert.deepEqual(parsePointer('/a/b/0'), ['a', 'b', '0']);
  assert.deepEqual(parsePointer('/a~1b/c~0d'), ['a/b', 'c~d']);
  // 从左往右一个字符一个字符地还原，所以 ~01 是 ~1
  assert.deepEqual(parsePointer('/~01'), ['~1']);
  assert.deepEqual(parsePointer('/'), ['']);

  assert.equal(formatPointer([]), '');
  assert.equal(formatPointer(['a/b', 'c~d']), '/a~1b/c~0d');
  assert.equal(formatPointer(['a', 0]), '/a/0');

  assert.equal(code(() => parsePointer('a/b')), 'ERR_BAD_POINTER');
  assert.equal(code(() => parsePointer('/a~2')), 'ERR_BAD_POINTER');
  assert.equal(code(() => parsePointer('/a~')), 'ERR_BAD_POINTER');
  assert.equal(code(() => parsePointer(7)), 'ERR_BAD_POINTER');
  assert.equal(code(() => formatPointer('a')), 'ERR_BAD_POINTER');
  assert.equal(code(() => formatPointer(['a', 1.5])), 'ERR_BAD_POINTER');
});

test('取不到的东西都算路径不存在，下标写歪了算指针不合法', () => {
  const doc = { a: { b: [1, 2] }, s: 'text' };
  assert.equal(get(doc, ''), doc);
  assert.equal(get(doc, '/a/b/1'), 2);
  assert.equal(code(() => get(doc, '/a/b/2')), 'ERR_PATH_MISSING');
  assert.equal(code(() => get(doc, '/a/b/-')), 'ERR_PATH_MISSING');
  assert.equal(code(() => get(doc, '/a/c')), 'ERR_PATH_MISSING');
  assert.equal(code(() => get(doc, '/s/0')), 'ERR_PATH_MISSING');
  assert.equal(code(() => get(doc, '/a/b/01')), 'ERR_BAD_POINTER');
  assert.equal(code(() => get(doc, '/a/b/-0')), 'ERR_BAD_POINTER');
  assert.equal(code(() => get(doc, '/a/b/x')), 'ERR_BAD_POINTER');
});
