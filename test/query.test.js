import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndex } from '../lib/index.js';

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

const index = createIndex();
index.add({ id: 'd1', title: 'alpha', body: 'beta gamma' });

test('写坏的查询当场报错', () => {
  expectError(() => index.search(''), 'ERR_BAD_QUERY');
  expectError(() => index.search('   '), 'ERR_BAD_QUERY');
  expectError(() => index.search('alpha | '), 'ERR_BAD_QUERY');
  expectError(() => index.search('| alpha'), 'ERR_BAD_QUERY');
  expectError(() => index.search('-'), 'ERR_BAD_QUERY');
  expectError(() => index.search('alpha -'), 'ERR_BAD_QUERY');
  expectError(() => index.search('"没关上的引号'), 'ERR_BAD_QUERY');
  expectError(() => index.search('""'), 'ERR_BAD_QUERY');
  expectError(() => index.search('a*b'), 'ERR_BAD_QUERY');
  expectError(() => index.search('al*ph*'), 'ERR_BAD_QUERY');
  expectError(() => index.search('"alpha bet*"'), 'ERR_BAD_QUERY');
  expectError(() => index.search('*(alpha)'), 'ERR_BAD_QUERY');
});

test('字段名只认 title / body / tags', () => {
  expectError(() => index.search('author:alpha'), 'ERR_BAD_QUERY');
  expectError(() => index.search('body:'), 'ERR_BAD_QUERY');
  assert.deepEqual(index.search('TITLE:alpha').map((item) => item.id), ['d1']);
});

test('标点不算词，只当分隔符', () => {
  assert.deepEqual(index.search('alpha, beta.').map((item) => item.id), ['d1']);
  expectError(() => index.search('!!!'), 'ERR_BAD_QUERY');
});

test('前缀只切一个词，中文前缀用不了', () => {
  expectError(() => index.search('周会*'), 'ERR_BAD_QUERY');
  assert.deepEqual(index.search('alp*').map((item) => item.id), ['d1']);
});
