import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../lib/engine.js';

const attributes = {
  subjects: {
    alice: { roles: ['editor'], groups: ['staff'], attrs: { dept: 'eng', level: 4 } },
    bob: { roles: ['viewer'], attrs: { dept: 'sales' } },
  },
  resources: {
    'doc:1': { type: 'doc', tags: ['public'], attrs: { owner: 'alice', year: 2024 } },
    'doc:9': { type: 'doc', tags: ['secret'], attrs: { owner: 'bob', year: 2019 } },
  },
  roles: { editor: { attrs: { canEdit: true, level: 2 } } },
  types: { doc: { attrs: { kind: 'content' } } },
};

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'PolicyError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

const policy = (id, effect, when) => ({
  id,
  effect,
  priority: 5,
  subjects: ['*'],
  actions: ['read'],
  resources: ['*'],
  when,
});

test('同一个请求第二次走缓存', () => {
  const engine = createEngine({ policies: [policy('recent', 'allow', { 'resource.year': { gte: 2020 } })], attributes });
  const request = { subject: 'alice', action: 'read', resource: 'doc:1' };
  const first = engine.evaluate(request);
  const second = engine.evaluate({ ...request });
  assert.deepEqual(second, first);
  assert.deepEqual(engine.cacheStats(), { hits: 1, misses: 1, size: 1 });
});

test('上下文不一样不算同一个请求', () => {
  const engine = createEngine({
    policies: [policy('gold-only', 'allow', { 'context.tier': { eq: 'gold' } })],
    attributes,
  });
  const base = { subject: 'alice', action: 'read', resource: 'doc:1' };
  assert.equal(engine.evaluate({ ...base, context: { tier: 'gold' } }).effect, 'allow');
  assert.equal(engine.evaluate({ ...base, context: { tier: 'bronze' } }).effect, 'deny');
  assert.deepEqual(engine.cacheStats(), { hits: 0, misses: 2, size: 2 });
});

test('换了策略，缓存跟着清掉', () => {
  const engine = createEngine({ policies: [policy('recent', 'allow', { 'resource.year': { gte: 2020 } })], attributes });
  const request = { subject: 'alice', action: 'read', resource: 'doc:9' };
  assert.equal(engine.evaluate(request).effect, 'deny');
  engine.setPolicies([policy('any-year', 'allow', null)]);
  assert.equal(engine.evaluate(request).effect, 'allow');
  assert.deepEqual(engine.cacheStats(), { hits: 0, misses: 2, size: 1 });
});

test('换了属性，缓存也清掉', () => {
  const engine = createEngine({ policies: [policy('eng-owner', 'allow', { 'subject.dept': { eq: 'eng' } })], attributes });
  const request = { subject: 'bob', action: 'read', resource: 'doc:1' };
  assert.equal(engine.evaluate(request).effect, 'deny');
  engine.setAttributes({
    ...attributes,
    subjects: { ...attributes.subjects, bob: { roles: ['viewer'], attrs: { dept: 'eng' } } },
  });
  assert.equal(engine.evaluate(request).effect, 'allow');
  assert.equal(engine.cacheStats().hits, 0);
});

test('invalidate 手动清，返回清掉了几条', () => {
  const engine = createEngine({ policies: [policy('any-year', 'allow', null)], attributes });
  engine.evaluate({ subject: 'alice', action: 'read', resource: 'doc:1' });
  engine.evaluate({ subject: 'bob', action: 'read', resource: 'doc:9' });
  assert.equal(engine.cacheStats().size, 2);
  assert.equal(engine.invalidate(), 2);
  assert.deepEqual(engine.cacheStats(), { hits: 0, misses: 2, size: 0 });
});

test('策略写错报 ERR_BAD_POLICY', () => {
  const cases = [
    [() => createEngine({ policies: [policy('dup', 'allow')], attributes }).setPolicies([policy('dup', 'allow'), policy('dup', 'deny')]), 'id'],
    [() => createEngine({ policies: [{ ...policy('x', 'maybe') }], attributes }), 'effect'],
    [() => createEngine({ policies: [policy('x', 'allow', { 'subject.level': { gte: 'three' } })], attributes }), 'when'],
    [() => createEngine({ policies: [{ ...policy('x', 'allow'), priority: 1.5 }], attributes }), 'priority'],
    [() => createEngine({ policies: [{ ...policy('x', 'allow'), subjects: [] }], attributes }), 'subjects'],
  ];
  for (const [fn, field] of cases) {
    const err = expectError(fn, 'ERR_BAD_POLICY');
    assert.equal(err.details.field, field);
  }
  const err = expectError(
    () => createEngine({ policies: [policy('x', 'allow', { 'subject.level': { maybe: 1 } })], attributes }),
    'ERR_BAD_POLICY',
  );
  assert.equal(err.details.op, 'maybe');
});

test('请求写错报 ERR_BAD_REQUEST', () => {
  const engine = createEngine({ policies: [policy('any', 'allow', null)], attributes });
  expectError(() => engine.evaluate({ subject: '', action: 'read', resource: 'doc:1' }), 'ERR_BAD_REQUEST');
  expectError(() => engine.evaluate({ subject: 'alice', action: 'read', resource: 'doc:1', context: [] }), 'ERR_BAD_REQUEST');
  const err = expectError(
    () => engine.evaluate({ subject: 'carol', action: 'read', resource: 'doc:1' }),
    'ERR_BAD_REQUEST',
  );
  assert.deepEqual({ field: err.details.field, value: err.details.value }, { field: 'subject', value: 'carol' });
  const missingResource = expectError(
    () => engine.evaluate({ subject: 'alice', action: 'read', resource: 'doc:404' }),
    'ERR_BAD_REQUEST',
  );
  assert.equal(missingResource.details.field, 'resource');
});
