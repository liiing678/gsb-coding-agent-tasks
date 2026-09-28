import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlagEngine } from '../lib/flagr.js';

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'FlagError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

const OFF = [{ variation: 'off', weight: 1000 }];

function engineWith(condition, match = 'all') {
  const engine = createFlagEngine();
  engine.defineFlag({
    key: 'f',
    variations: ['hit', 'off'],
    offVariation: 'off',
    rules: [{ id: 'r', match, conditions: [condition], serve: 'hit' }],
    rollout: OFF,
  });
  return engine;
}

const evaluate = (engine, attributes) => engine.evaluate({ key: 'f', context: { userKey: 'u-1', attributes } }).variation;

test('eq / in 是严格相等，缺属性一律不匹配', () => {
  assert.equal(evaluate(engineWith({ attribute: 'plan', operator: 'eq', values: ['pro'] }), { plan: 'pro' }), 'hit');
  assert.equal(evaluate(engineWith({ attribute: 'plan', operator: 'eq', values: ['pro'] }), { plan: 'PRO' }), 'off');
  assert.equal(evaluate(engineWith({ attribute: 'plan', operator: 'eq', values: ['pro'] }), {}), 'off');
  assert.equal(evaluate(engineWith({ attribute: 'n', operator: 'eq', values: [1] }), { n: '1' }), 'off');
  assert.equal(evaluate(engineWith({ attribute: 'plan', operator: 'in', values: ['pro', 'team'] }), { plan: 'team' }), 'hit');
});

test('null 只有显式写了才算存在，exists 看的是有没有这个键', () => {
  assert.equal(evaluate(engineWith({ attribute: 'tag', operator: 'eq', values: [null] }), { tag: null }), 'hit');
  assert.equal(evaluate(engineWith({ attribute: 'tag', operator: 'exists', values: [] }), { tag: null }), 'hit');
  assert.equal(evaluate(engineWith({ attribute: 'tag', operator: 'exists', values: [] }), {}), 'off');
});

test('字符串三个算子和数值比较都要求类型对得上', () => {
  assert.equal(evaluate(engineWith({ attribute: 'mail', operator: 'contains', values: ['@corp'] }), { mail: 'a@corp.com' }), 'hit');
  assert.equal(evaluate(engineWith({ attribute: 'mail', operator: 'startsWith', values: ['a@'] }), { mail: 'a@corp.com' }), 'hit');
  assert.equal(evaluate(engineWith({ attribute: 'mail', operator: 'endsWith', values: ['.com'] }), { mail: 'a@corp.com' }), 'hit');
  assert.equal(evaluate(engineWith({ attribute: 'mail', operator: 'contains', values: ['@corp'] }), { mail: 5 }), 'off');
  assert.equal(evaluate(engineWith({ attribute: 'age', operator: 'gt', values: [18] }), { age: 19 }), 'hit');
  assert.equal(evaluate(engineWith({ attribute: 'age', operator: 'gt', values: [18] }), { age: '19' }), 'off');
  assert.equal(evaluate(engineWith({ attribute: 'age', operator: 'lt', values: [18] }), { age: 18 }), 'off');
});

test('match=any 命中一条就算，空条件列表的 all 恒真、any 恒假', () => {
  const engine = createFlagEngine();
  engine.defineFlag({
    key: 'f',
    variations: ['hit', 'off'],
    offVariation: 'off',
    rules: [{
      id: 'r',
      match: 'any',
      conditions: [
        { attribute: 'a', operator: 'eq', values: ['x'] },
        { attribute: 'b', operator: 'eq', values: ['y'] },
      ],
      serve: 'hit',
    }],
    rollout: OFF,
  });
  assert.equal(evaluate(engine, { b: 'y' }), 'hit');
  assert.equal(evaluate(engine, { a: 'x' }), 'hit');
  assert.equal(evaluate(engine, { a: 'x', b: 'y' }), 'hit');
  assert.equal(evaluate(engine, { b: 'z' }), 'off');

  assert.equal(evaluate(engineWithEmpty('all'), {}), 'hit');
  assert.equal(evaluate(engineWithEmpty('any'), {}), 'off');
});

function engineWithEmpty(match) {
  const engine = createFlagEngine();
  engine.defineFlag({
    key: 'f',
    variations: ['hit', 'off'],
    offVariation: 'off',
    rules: [{ id: 'r', match, conditions: [], serve: 'hit' }],
    rollout: OFF,
  });
  return engine;
}

test('未知算子、缺字段、重名规则都算 ERR_BAD_FLAG', () => {
  const engine = createFlagEngine();
  expectError(() => engine.defineFlag({
    key: 'f', variations: ['on'],
    rules: [{ id: 'r', conditions: [{ attribute: 'a', operator: 'nope', values: [] }], serve: 'on' }],
  }), 'ERR_BAD_FLAG');
  expectError(() => engine.defineFlag({
    key: 'f', variations: ['on'],
    rules: [{ id: 'r', conditions: [{ attribute: '', operator: 'eq', values: ['x'] }], serve: 'on' }],
  }), 'ERR_BAD_FLAG');
  expectError(() => engine.defineFlag({
    key: 'f', variations: ['on'],
    rules: [{ id: 'r', conditions: [{ attribute: 'a', operator: 'eq', values: 'x' }], serve: 'on' }],
  }), 'ERR_BAD_FLAG');
  expectError(() => engine.defineFlag({
    key: 'f', variations: ['on'],
    rules: [
      { id: 'r', conditions: [], serve: 'on' },
      { id: 'r', conditions: [], serve: 'on' },
    ],
  }), 'ERR_BAD_FLAG');
  expectError(() => engine.defineFlag({ key: 'f', variations: ['on'], rules: 'nope' }), 'ERR_BAD_FLAG');
});

test('依赖链要能过环检测，别人还在用就不能删', () => {
  const engine = createFlagEngine();
  engine.defineFlag({ key: 'a', variations: ['on'] });
  engine.defineFlag({ key: 'b', variations: ['on'], requires: [{ flag: 'a', variation: 'on' }] });
  expectError(() => engine.updateFlag({ key: 'a', variations: ['on'], requires: [{ flag: 'b', variation: 'on' }] }), 'ERR_FLAG_CYCLE');
  expectError(() => engine.updateFlag({ key: 'a', variations: ['on'], requires: [{ flag: 'a', variation: 'on' }] }), 'ERR_FLAG_CYCLE');
  expectError(() => engine.removeFlag({ key: 'a' }), 'ERR_FLAG_IN_USE');
  expectError(() => engine.defineFlag({ key: 'c', variations: ['on'], requires: [{ flag: 'nope', variation: 'on' }] }), 'ERR_UNKNOWN_FLAG');
  expectError(() => engine.defineFlag({ key: 'c', variations: ['on'], requires: [{ flag: 'a', variation: 'nope' }] }), 'ERR_BAD_FLAG');
  assert.deepEqual(engine.removeFlag({ key: 'b' }), { key: 'b', removed: true });
  assert.deepEqual(engine.removeFlag({ key: 'a' }), { key: 'a', removed: true });
  expectError(() => engine.removeFlag({ key: 'a' }), 'ERR_UNKNOWN_FLAG');
});

test('统计只记顶层那一次求值', () => {
  const engine = createFlagEngine();
  engine.defineFlag({ key: 'base', variations: ['on'], offVariation: 'on' });
  engine.defineFlag({ key: 'top', variations: ['on'], offVariation: 'on', requires: [{ flag: 'base', variation: 'on' }] });
  engine.evaluate({ key: 'top', context: { userKey: 'u-1' } });
  assert.deepEqual(engine.stats(), {
    flags: 2,
    evaluations: 1,
    byReason: { prerequisite: 0, rule: 0, rollout: 0, default: 1 },
  });
});
