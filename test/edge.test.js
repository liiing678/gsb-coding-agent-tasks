import test from 'node:test';
import assert from 'node:assert/strict';

import { compile } from '../lib/exprvm.js';
import { ExprError } from '../lib/errors.js';
import { code, details, outcome } from './util.js';

const run = (source, env) => compile(source).run(env);

test('写坏的表达式一律 ERR_BAD_SYNTAX，并且带位置', () => {
  const broken = [
    '', '   ', '1 +', '+ 1', '1 2', '(1', '1)', 'a b', '1 +* 2', '"abc', "'abc",
    '1..2', '0x', '1e', '@', 'a.', '?', ':', 'a ? b', 'a ? b :', ')', '(', '1 ? : 2',
    'a &&', '1 = 1', 'x[0]',
  ];
  for (const source of broken) {
    assert.equal(code(() => compile(source)), 'ERR_BAD_SYNTAX', `源码 ${JSON.stringify(source)}`);
  }
  // 这些是合法的，别跟着一起报错
  const fine = ['1', 'a', '(1)', 'a||b', 'a?b:c', '"x"', "'x'", '1.5', '0xff', '1e-3',
    '-1', '!a', 'a&&b||c', 'a==b', 'a<b', 'true', 'null', '- -1'];
  for (const source of fine) {
    assert.equal(code(() => compile(source)), null, `源码 ${JSON.stringify(source)}`);
  }
  assert.deepEqual(details(() => compile('1 +\n* 2')), { index: 4, line: 2, column: 1 });
  assert.deepEqual(details(() => compile('a\n?? b')), { index: 3, line: 2, column: 2 });
  assert.deepEqual(details(() => compile('1 +\n')), { index: 4, line: 2, column: 1 });
});

test('类型不对与除零都要抛 ExprError', () => {
  const cases = [
    ['1 / 0', 'ERR_DIVIDE_BY_ZERO'],
    ['1 % 0', 'ERR_DIVIDE_BY_ZERO'],
    ['"a" - 1', 'ERR_TYPE'],
    ['"a" * 2', 'ERR_TYPE'],
    ['"a" / 2', 'ERR_TYPE'],
    ['"a" % 2', 'ERR_TYPE'],
    ['true < 2', 'ERR_TYPE'],
    ['null == 0', 'ERR_TYPE'],
    ['"1" != 1', 'ERR_TYPE'],
    ['-null', 'ERR_TYPE'],
    ['-true', 'ERR_TYPE'],
  ];
  for (const [source, expected] of cases) {
    assert.equal(code(() => run(source)), expected, `源码 ${source}`);
  }
  let thrown = null;
  try {
    run('1 / 0');
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof ExprError);
  assert.equal(thrown.code, 'ERR_DIVIDE_BY_ZERO');
  assert.equal(typeof thrown.message, 'string');
  assert.deepEqual(thrown.details, {});

  const unknown = (() => {
    try {
      run('nope');
    } catch (err) {
      return err;
    }
    return null;
  })();
  assert.deepEqual(unknown.details, { name: 'nope' });
});

test('折叠过和没折叠，跑出来的结果与错误必须一模一样', () => {
  const cases = [
    ['1 + 2 * 3', undefined, 7],
    ['1 - "a"', undefined, 'ERR_TYPE'],
    ['1 / 0', undefined, 'ERR_DIVIDE_BY_ZERO'],
    ['false && (1 / 0)', undefined, false],
    ['true || (1 / 0)', undefined, true],
    ['0 && nope', undefined, 0],
    ['null ? 1 : 2', undefined, 2],
    ['1 ? 2 : 3 ? 4 : 5', undefined, 2],
    ['x ? "a" + 1 : "b"', {x: true}, "a1"],
    ['x ? "a" + 1 : "b"', {x: ""}, "b"],
    ['(x || 7) + 1', {x: 0}, 8],
    ['x && y && 3', {x: 1,y: 2}, 3],
    ['x && y && 3', {x: 1}, 'ERR_UNKNOWN_NAME'],
    ['!(x < 2) || y', {x: 5,y: "fallback"}, true],
    ['1 + 1 + 1 + x', {x: 4}, 7],
    ['("a" + "b") + ("c" + 1)', undefined, "abc1"],
    ['x == y', {x: 1,y: 1}, true],
    ['x == y', {x: 1,y: "1"}, 'ERR_TYPE'],
    ['x < y', {x: "a",y: "b"}, true],
    ['-x * -2', {x: 3}, 6],
    ['x % 3', {x: -7}, -1],
    ['(x ? 1 : 2) + (y ? 3 : 4)', {x: false,y: true}, 5],
    ['1 == 2 || 3 < 4 && true', undefined, true],
    ['nope', {}, 'ERR_UNKNOWN_NAME'],
  ];
  for (const [source, env, expected] of cases) {
    const want = typeof expected === 'string' && expected.startsWith('ERR_')
      ? { error: expected }
      : { value: expected };
    const note = `源码 ${source} 环境 ${JSON.stringify(env)}`;
    assert.deepEqual(outcome(compile, source, env, { optimize: false }), want, `${note}（没折叠）`);
    assert.deepEqual(outcome(compile, source, env, { optimize: true }), want, `${note}（折叠过）`);
  }
});

test('指令序列：优化器只做常量折叠和常量分支消除', () => {
  assert.deepEqual(compile('1+2*3', { optimize: false }).assembly,
    ['CONST 1', 'CONST 2', 'CONST 3', 'BIN mul', 'BIN add', 'RET']);
  assert.deepEqual(compile('1+2*3').assembly, ['CONST 7', 'RET']);
  assert.deepEqual(compile('a && b', { optimize: false }).assembly,
    ['LOAD a', 'DUP', 'JUMPF 5', 'POP', 'LOAD b', 'RET']);
  assert.deepEqual(compile('a || b', { optimize: false }).assembly,
    ['LOAD a', 'DUP', 'JUMPT 5', 'POP', 'LOAD b', 'RET']);
  assert.deepEqual(compile('a ? b : c', { optimize: false }).assembly,
    ['LOAD a', 'JUMPF 4', 'LOAD b', 'JUMP 5', 'LOAD c', 'RET']);
  assert.deepEqual(compile('-a', { optimize: false }).assembly, ['LOAD a', 'UNARY neg', 'RET']);
  assert.deepEqual(compile('!1').assembly, ['CONST false', 'RET']);
  assert.deepEqual(compile('1 + 2 == 3').assembly, ['CONST true', 'RET']);
  // 会抛错的组合不许折掉
  assert.deepEqual(compile('1/0').assembly, ['CONST 1', 'CONST 0', 'BIN div', 'RET']);
  assert.deepEqual(compile('1 - "a"').assembly,
    ['CONST 1', 'CONST "a"', 'BIN sub', 'RET']);
  // 常量条件：死掉的那半边必须整段消失
  assert.deepEqual(compile('true ? 1 : nope').assembly, ['CONST 1', 'RET']);
  assert.deepEqual(compile('false ? nope : 1').assembly, ['CONST 1', 'RET']);
  assert.deepEqual(compile('0 && nope').assembly, ['CONST 0', 'RET']);
  assert.deepEqual(compile('1 || nope').assembly, ['CONST 1', 'RET']);
  assert.deepEqual(compile('0 || x').assembly, ['LOAD x', 'RET']);
  assert.deepEqual(compile('1 && x').assembly, ['LOAD x', 'RET']);
});

test('入参校验与长表达式', () => {
  for (const source of [7, null, undefined, {}, [], true]) {
    assert.equal(code(() => compile(source)), 'ERR_BAD_ARGUMENT');
  }
  for (const options of ['x', 7, [], true, null]) {
    assert.equal(code(() => compile('a', options)), 'ERR_BAD_ARGUMENT');
  }
  for (const optimize of [0, 1, 'true', null]) {
    assert.equal(code(() => compile('a', { optimize })), 'ERR_BAD_ARGUMENT');
  }
  const program = compile('a');
  for (const env of [7, 'x', [], true, null]) {
    assert.equal(code(() => program.run(env)), 'ERR_BAD_ARGUMENT');
  }
  assert.equal(code(() => program.run()), 'ERR_UNKNOWN_NAME');

  const sum = Array.from({ length: 2000 }, (_, i) => i + 1).join(' + ');
  assert.equal(run(sum), 2001000);
  const nested = `${'('.repeat(500)}1 + 2${')'.repeat(500)}`;
  assert.equal(run(nested), 3);
  const names = Array.from({ length: 500 }, (_, i) => `n${i}`).join(' + ');
  const env = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`n${i}`, i]));
  assert.equal(run(names, env), 124750);
  assert.deepEqual(compile('(!(1 < 2) || 3) && "ok"').assembly, ['CONST "ok"', 'RET']);
  assert.deepEqual(compile('1 ? "a" : nope').assembly, ['CONST "a"', 'RET']);
});
