import test from 'node:test';
import assert from 'node:assert/strict';

import { compile } from '../lib/exprvm.js';
import { code, outcome } from './util.js';

const run = (source, env) => compile(source).run(env);

test('数字、算术与优先级', () => {
  assert.equal(run('1'), 1);
  assert.equal(run('1.5'), 1.5);
  assert.equal(run('.5'), 0.5);
  assert.equal(run('1e3'), 1000);
  assert.equal(run('0x1f'), 31);
  assert.equal(run('1 + 2 * 3'), 7);
  assert.equal(run('(1 + 2) * 3'), 9);
  assert.equal(run('10 - 2 - 3'), 5);
  assert.equal(run('100 / 5 / 2'), 10);
  assert.equal(run('7 % 3'), 1);
  assert.equal(run('-7 % 3'), -1);
  assert.equal(run('2 * -3'), -6);
  assert.equal(run('1 + 2 * 3 - 4 / 2'), 5);
});

test('字符串、拼接与取值文本化', () => {
  assert.equal(run('"ab" + "cd"'), 'abcd');
  assert.equal(run('"n=" + 42'), 'n=42');
  assert.equal(run('42 + "n"'), '42n');
  assert.equal(run('"x" + true + false'), 'xtruefalse');
  assert.equal(run('"x" + null'), 'x');
  assert.equal(run("'a\\tb'"), 'a\tb');
  assert.equal(run('"say \\"hi\\""'), 'say "hi"');
  assert.equal(run('"back\\\\slash"'), 'back\\slash');
  assert.equal(run('"-0: " + -0'), '-0: 0');
});

test('比较、判等与类型规则', () => {
  assert.equal(run('1 < 2'), true);
  assert.equal(run('2 <= 2'), true);
  assert.equal(run('"a" < "b"'), true);
  assert.equal(run('"abc" > "abd"'), false);
  assert.equal(run('1 == 1'), true);
  assert.equal(run('1 != 1'), false);
  assert.equal(run('"1" == "1"'), true);
  assert.equal(run('null == null'), true);
  assert.equal(code(() => run('"1" == 1')), 'ERR_TYPE');
  assert.equal(code(() => run('1 < "b"')), 'ERR_TYPE');
  assert.equal(code(() => run('1 - "b"')), 'ERR_TYPE');
  assert.equal(code(() => run('true + 1')), 'ERR_TYPE');
});

test('真假值与短路：没走到的分支不求值', () => {
  assert.equal(run('0 || 5'), 5);
  assert.equal(run('1 || 5'), 1);
  assert.equal(run('"" || "空"'), '空');
  assert.equal(run('null || 7'), 7);
  assert.equal(run('1 && 2'), 2);
  assert.equal(run('0 && 2'), 0);
  assert.equal(run('"x" && 3'), 3);
  assert.equal(run('!0'), true);
  assert.equal(run('!"x"'), false);
  assert.equal(run('!!null'), false);
  // 右边是「会炸」的东西，短路了就不该炸
  assert.equal(run('false && (1 / 0)'), false);
  assert.equal(run('true || nope'), true);
  assert.equal(run('null && nope'), null);
  assert.equal(code(() => run('true && nope')), 'ERR_UNKNOWN_NAME');
  assert.equal(code(() => run('false || (1 / 0)')), 'ERR_DIVIDE_BY_ZERO');
});

test('三元、括号与一元叠加', () => {
  assert.equal(run('1 ? "a" : "b"'), 'a');
  assert.equal(run('0 ? "a" : "b"'), 'b');
  assert.equal(run('null ? 1 : 2'), 2);
  assert.equal(run('1 ? 0 ? "x" : "y" : "z"'), 'y');
  assert.equal(run('0 ? "x" : 1 ? "y" : "z"'), 'y');
  assert.equal(run('1 ? 2 : 3 ? 4 : 5'), 2);
  assert.equal(run('0 ? 2 : 0 ? 4 : 5'), 5);
  assert.equal(code(() => run('1 ? (2 / 0) : 9')), 'ERR_DIVIDE_BY_ZERO');
  assert.equal(run('0 ? (2 / 0) : 9'), 9);
  assert.equal(run('- -3'), 3);
  assert.equal(run('!!1'), true);
  assert.equal(run('-(1 + 2) * -2'), 6);
  assert.equal(code(() => run('-"a"')), 'ERR_TYPE');
});

test('环境里的名字', () => {
  assert.equal(run('a + b * 2', { a: 1, b: 3 }), 7);
  assert.equal(run('name + "!"', { name: 'ada' }), 'ada!');
  assert.equal(run('flag ? "on" : "off"', { flag: false }), 'off');
  assert.equal(run('nothing', { nothing: null }), null);
  assert.equal(run('a_b1', { a_b1: 9 }), 9);
  assert.equal(code(() => run('missing', { a: 1 })), 'ERR_UNKNOWN_NAME');
  assert.equal(code(() => run('a', {})), 'ERR_UNKNOWN_NAME');
  assert.equal(code(() => run('a', { a: undefined })), 'ERR_TYPE');
  assert.equal(code(() => run('a', { a: {} })), 'ERR_TYPE');
  assert.equal(code(() => run('a', { a: [1] })), 'ERR_TYPE');
  assert.equal(code(() => run('a', { a: () => 1 })), 'ERR_TYPE');
  // 名字大小写敏感，true / false / null 是关键字不是变量
  assert.equal(code(() => run('A', { a: 1 })), 'ERR_UNKNOWN_NAME');
  assert.equal(run('true'), true);
  const program = compile('a * 2');
  assert.equal(program.run({ a: 2 }), 4);
  assert.equal(program.run({ a: 5 }), 10);
  assert.equal(program.run({ a: 0 }), 0);
  assert.equal(outcome(compile, 'x', { x: 1 }, { optimize: false }).value, 1);
});
