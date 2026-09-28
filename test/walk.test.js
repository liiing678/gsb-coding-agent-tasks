import test from 'node:test';
import assert from 'node:assert/strict';

import { createIgnore } from '../lib/globignore.js';
import { IgnoreError } from '../lib/errors.js';

test('最后一条命中的规则说话，取反规则能把它翻回来', () => {
  const ignore = createIgnore({ lines: ['*.log', '!keep.log'] });
  assert.deepEqual(ignore.test('a.log'), { ignored: true, rule: 0, blockedBy: null });
  assert.deepEqual(ignore.test('keep.log'), { ignored: false, rule: 1, blockedBy: null });
  assert.deepEqual(ignore.test('sub/keep.log'), { ignored: false, rule: 1, blockedBy: null });
  assert.deepEqual(ignore.test('nope.txt'), { ignored: false, rule: null, blockedBy: null });
});

test('目录被排掉以后，里面再怎么取反也翻不了案', () => {
  const ignore = createIgnore({ lines: ['logs/', '!logs/important.log'] });
  assert.deepEqual(ignore.test('logs', { isDir: true }),
    { ignored: true, rule: 0, blockedBy: null });
  assert.deepEqual(ignore.test('logs/important.log'),
    { ignored: true, rule: null, blockedBy: 'logs' });
  assert.deepEqual(ignore.test('logs/deep/other.txt'),
    { ignored: true, rule: null, blockedBy: 'logs' });
});

test('父目录自己先被取反翻回来，里面的文件就还能单独说话', () => {
  const ignore = createIgnore({ lines: ['build/', '!build/', '!build/keep.md', 'build/*.tmp'] });
  assert.deepEqual(ignore.test('build', { isDir: true }),
    { ignored: false, rule: 1, blockedBy: null });
  assert.deepEqual(ignore.test('build/keep.md'),
    { ignored: false, rule: 2, blockedBy: null });
  assert.deepEqual(ignore.test('build/x.tmp'),
    { ignored: true, rule: 3, blockedBy: null });
  assert.deepEqual(ignore.test('build/out.js'),
    { ignored: false, rule: null, blockedBy: null });
});

test('剪枝看的是被排除的最外面那一层目录', () => {
  const ignore = createIgnore({ lines: ['a/', 'a/b/'] });
  assert.deepEqual(ignore.test('a/b/c.txt'),
    { ignored: true, rule: null, blockedBy: 'a' });
  const inner = createIgnore({ lines: ['!a/', 'a/b/'] });
  assert.deepEqual(inner.test('a/b/c.txt'),
    { ignored: true, rule: null, blockedBy: 'a/b' });
});

test('partition 按输入顺序分成两份，目录条目也参与剪枝', () => {
  const ignore = createIgnore({ lines: ['build/', '*.log'] });
  const entries = [
    { path: 'src/main.js' },
    { path: 'build', isDir: true },
    { path: 'build/out.js' },
    { path: 'error.log' },
    { path: 'src/util.js' },
  ];
  const { kept, ignored } = ignore.partition(entries);
  assert.deepEqual(kept.map((one) => one.path), ['src/main.js', 'src/util.js']);
  assert.deepEqual(ignored.map((one) => one.path), ['build', 'build/out.js', 'error.log']);
});

test('参数和路径没给对就抛，码要分开', () => {
  const code = (fn) => {
    try {
      fn();
      return null;
    } catch (err) {
      return err.code;
    }
  };

  assert.equal(code(() => createIgnore()), 'ERR_BAD_ARGS');
  assert.equal(code(() => createIgnore({ lines: 'build/' })), 'ERR_BAD_ARGS');
  assert.equal(code(() => createIgnore({ lines: [1] })), 'ERR_BAD_ARGS');
  assert.equal(code(() => createIgnore({ lines: [], caseSensitive: 'yes' })), 'ERR_BAD_ARGS');

  const ignore = createIgnore({ lines: ['build/'] });
  assert.equal(code(() => ignore.test('')), 'ERR_BAD_PATH');
  assert.equal(code(() => ignore.test('/build')), 'ERR_BAD_PATH');
  assert.equal(code(() => ignore.test('build/')), 'ERR_BAD_PATH');
  assert.equal(code(() => ignore.test('a/../b')), 'ERR_BAD_PATH');
  assert.equal(code(() => ignore.test('a//b')), 'ERR_BAD_PATH');
  assert.equal(code(() => ignore.test('a\\b')), 'ERR_BAD_PATH');
  assert.equal(code(() => ignore.test(3)), 'ERR_BAD_PATH');
  assert.equal(code(() => ignore.test('build', { isDir: 'yes' })), 'ERR_BAD_ARGS');
  assert.equal(code(() => ignore.test('build', null)), 'ERR_BAD_ARGS');
  assert.equal(code(() => ignore.partition('build')), 'ERR_BAD_ARGS');
  assert.equal(code(() => ignore.partition([null])), 'ERR_BAD_ARGS');
  assert.ok(new IgnoreError('ERR_BAD_PATH', 'x') instanceof Error);
});
