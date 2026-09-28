import test from 'node:test';
import assert from 'node:assert/strict';

import { displayWidth } from '../lib/wrapfold.js';
import { code } from './util.js';

test('宽度按码点算：汉字全角 2、组合记号 0、emoji 2、ASCII 1', () => {
  assert.equal(displayWidth(''), 0);
  assert.equal(displayWidth('中文 abc'), 8);
  assert.equal(displayWidth('a\u0301'), 1);
  assert.equal(displayWidth(String.fromCodePoint(0x1f600)), 2);
  assert.equal(displayWidth('\u200b'), 0);
  assert.equal(displayWidth('\t'), 1);
  assert.equal(displayWidth('Ａ１'), 4);
  assert.equal(code(() => displayWidth(7)), 'ERR_BAD_ARGS');
});

test('宽度表格边界上的码点', () => {
  assert.equal(displayWidth('\u1100'), 2);
  assert.equal(displayWidth('\u00e9'), 1);
  assert.equal(displayWidth('\uff01'), 2);
  assert.equal(displayWidth('\u0301'), 0);
  assert.equal(displayWidth('\u1ab0'), 0);
  assert.equal(displayWidth('\u303f'), 1);
  assert.equal(displayWidth(String.fromCodePoint(0x1f900)), 2);
  assert.equal(displayWidth(String.fromCodePoint(0x20000)), 2);
  assert.equal(displayWidth(String.fromCodePoint(0x3fffd)), 2);
});
