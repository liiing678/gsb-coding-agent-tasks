import test from 'node:test';
import assert from 'node:assert/strict';

import { createIgnore, DEFAULTS } from '../lib/globignore.js';
import { IgnoreError } from '../lib/errors.js';

const verdict = (ignore, path, isDir = false) => {
  const out = ignore.test(path, { isDir });
  return `${out.ignored ? 'I' : 'k'}:${out.rule === null ? '-' : out.rule}`;
};

test('默认大小写敏感，注释、空行和行尾空格不算规则', () => {
  assert.equal(DEFAULTS.caseSensitive, true);
  const ignore = createIgnore({ lines: ['# 注释', '', '   ', 'build/   ', '\\#weird'] });
  assert.deepEqual(ignore.rules().map((one) => one.source), ['build/', '\\#weird']);
  assert.deepEqual(ignore.rules().map((one) => one.index), [3, 4]);
  assert.equal(verdict(ignore, 'build', true), 'I:3');
  assert.equal(verdict(ignore, 'build', false), 'k:-');
  assert.equal(verdict(ignore, '#weird'), 'I:4');
});

test('带斜杠的规则锚在根上，不带斜杠的规则哪一层都算', () => {
  const ignore = createIgnore({ lines: ['/dist', 'notes.md'] });
  assert.equal(verdict(ignore, 'dist'), 'I:0');
  assert.equal(verdict(ignore, 'a/dist'), 'k:-');
  assert.equal(verdict(ignore, 'notes.md'), 'I:1');
  assert.equal(verdict(ignore, 'a/b/notes.md'), 'I:1');
  assert.deepEqual(ignore.rules().map((one) => one.anchored), [true, false]);
});

test('`*` 和 `?` 都在一段里打转，不跨斜杠', () => {
  const ignore = createIgnore({ lines: ['*.log', 'log?'] });
  assert.equal(verdict(ignore, 'a.log'), 'I:0');
  assert.equal(verdict(ignore, 'deep/a.log'), 'I:0');
  assert.equal(verdict(ignore, 'a.log.bak'), 'k:-');
  assert.equal(verdict(ignore, 'log1'), 'I:1');
  assert.equal(verdict(ignore, 'log12'), 'k:-');
  assert.equal(verdict(ignore, 'xlog1'), 'k:-');
  assert.equal(verdict(ignore, 'sub/log1'), 'I:1');
});

test('`**` 跨目录：中间能是零层，写在结尾时至少要吃掉一层', () => {
  const ignore = createIgnore({ lines: ['docs/**/tmp', 'cache/**', '**/generated'] });
  assert.equal(verdict(ignore, 'docs/tmp', true), 'I:0');
  assert.equal(verdict(ignore, 'docs/v1/tmp', true), 'I:0');
  assert.equal(verdict(ignore, 'docs/v1/v2/tmp', true), 'I:0');
  assert.deepEqual(ignore.test('docs/v1/tmp/note.md'),
    { ignored: true, rule: null, blockedBy: 'docs/v1/tmp' });
  assert.equal(verdict(ignore, 'docs/v1/tmp2', true), 'k:-');
  assert.equal(verdict(ignore, 'cache', true), 'k:-');
  assert.equal(verdict(ignore, 'cache/one.bin'), 'I:1');
  assert.deepEqual(ignore.test('cache/a/b.bin'),
    { ignored: true, rule: null, blockedBy: 'cache/a' });
  assert.equal(verdict(ignore, 'generated'), 'I:2');
  assert.equal(verdict(ignore, 'a/b/generated'), 'I:2');
});

test('字符类支持区间和取反，`!` 也是取反', () => {
  const ignore = createIgnore({ lines: ['file[0-9].txt', 'x[!a-c]y', 'v[!a]'] });
  assert.equal(verdict(ignore, 'file3.txt'), 'I:0');
  assert.equal(verdict(ignore, 'fileA.txt'), 'k:-');
  assert.equal(verdict(ignore, 'xzy'), 'I:1');
  assert.equal(verdict(ignore, 'xby'), 'k:-');
  assert.equal(verdict(ignore, 'xay'), 'k:-');
  assert.equal(verdict(ignore, 'v!'), 'I:2');
  assert.equal(verdict(ignore, 'va'), 'k:-');
});

test('大小写不敏感是可选项，两边都折成小写比', () => {
  const strict = createIgnore({ lines: ['*.LOG'] });
  assert.equal(verdict(strict, 'a.log'), 'k:-');
  assert.equal(verdict(strict, 'A.LOG'), 'I:0');

  const loose = createIgnore({ lines: ['*.LOG'], caseSensitive: false });
  assert.equal(verdict(loose, 'a.log'), 'I:0');
  assert.equal(verdict(loose, 'A.LOG'), 'I:0');
  assert.equal(verdict(loose, 'a.log.bak'), 'k:-');
});

test('规则里的空白和反斜杠转义按口径处理', () => {
  const ignore = createIgnore({ lines: ['a\\ b.txt', 'a\\*b', '  lead.txt'] });
  assert.equal(verdict(ignore, 'a b.txt'), 'I:0');
  assert.equal(verdict(ignore, 'a*b'), 'I:1');
  assert.equal(verdict(ignore, 'aXb'), 'k:-');
  assert.equal(verdict(ignore, '  lead.txt'), 'I:2');
});

test('不合法的地方一律抛 IgnoreError，带上码和位置', () => {
  const bad = (lines) => {
    try {
      createIgnore({ lines });
      return null;
    } catch (err) {
      return err;
    }
  };

  const alone = bad(['!']);
  assert.ok(alone instanceof IgnoreError);
  assert.equal(alone.code, 'ERR_BAD_RULE');
  assert.equal(alone.details.index, 0);

  assert.equal(bad(['a**b']).code, 'ERR_BAD_RULE');
  assert.equal(bad(['a//b']).code, 'ERR_BAD_RULE');
  assert.equal(bad(['a[b']).code, 'ERR_BAD_RULE');
  assert.equal(bad(['[]']).code, 'ERR_BAD_RULE');
  assert.equal(bad(['/']).code, 'ERR_BAD_RULE');
});
