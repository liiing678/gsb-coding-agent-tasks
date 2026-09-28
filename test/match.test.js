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
    'report:7': { type: 'report', attrs: { owner: 'alice', year: 2024 } },
  },
  roles: { editor: { attrs: { canEdit: true, level: 2 } } },
  types: { doc: { attrs: { kind: 'content' } }, report: { attrs: { kind: 'summary' } } },
};

const read = (request, attributesMap, policy) =>
  createEngine({ policies: [policy], attributes: attributesMap }).evaluate(request);

test('主体可以是具体的人、角色、组或者 *', () => {
  const ask = (subject) => read({ subject, action: 'read', resource: 'doc:1' }, attributes, {
    id: 'allow-readers',
    effect: 'allow',
    priority: 1,
    subjects: ['role:editor', 'group:staff'],
    actions: ['read'],
    resources: ['*'],
  });
  assert.equal(ask('alice').effect, 'allow');
  assert.equal(ask('bob').effect, 'deny');
  assert.equal(ask('bob').reason, 'no-match');
});

test('动作和资源都支持结尾通配', () => {
  const policy = {
    id: 'write-doc',
    effect: 'allow',
    priority: 1,
    subjects: ['*'],
    actions: ['write*'],
    resources: ['doc:*'],
  };
  assert.equal(read({ subject: 'alice', action: 'write', resource: 'doc:1' }, attributes, policy).effect, 'allow');
  assert.equal(
    read({ subject: 'alice', action: 'writeDraft', resource: 'doc:9' }, attributes, policy).effect,
    'allow',
  );
  assert.equal(read({ subject: 'alice', action: 'read', resource: 'doc:1' }, attributes, policy).effect, 'deny');
  assert.equal(
    read({ subject: 'alice', action: 'write', resource: 'report:7' }, attributes, policy).effect,
    'deny',
  );
});

test('角色的属性会继承过来，自己的属性盖住角色的', () => {
  const policy = {
    id: 'senior-editor',
    effect: 'allow',
    priority: 1,
    subjects: ['role:editor'],
    actions: ['edit'],
    resources: ['*'],
    when: { 'subject.canEdit': { eq: true }, 'subject.level': { eq: 4 } },
  };
  assert.equal(read({ subject: 'alice', action: 'edit', resource: 'doc:1' }, attributes, policy).effect, 'allow');
  assert.equal(read({ subject: 'bob', action: 'edit', resource: 'doc:1' }, attributes, policy).effect, 'deny');
});

test('资源类型的属性也并进资源作用域', () => {
  const policy = {
    id: 'content-only',
    effect: 'allow',
    priority: 1,
    subjects: ['*'],
    actions: ['read'],
    resources: ['*'],
    when: { 'resource.kind': { eq: 'content' } },
  };
  assert.equal(read({ subject: 'alice', action: 'read', resource: 'doc:1' }, attributes, policy).effect, 'allow');
  assert.equal(
    read({ subject: 'alice', action: 'read', resource: 'report:7' }, attributes, policy).effect,
    'deny',
  );
});

test('数组属性用 has，上下文用 in', () => {
  const policy = {
    id: 'public-and-gold',
    effect: 'allow',
    priority: 1,
    subjects: ['*'],
    actions: ['read'],
    resources: ['*'],
    when: { 'resource.tags': { has: 'public' }, 'context.tier': { in: ['gold', 'silver'] } },
  };
  const ask = (resource, tier) =>
    read({ subject: 'alice', action: 'read', resource, context: { tier } }, attributes, policy).effect;
  assert.equal(ask('doc:1', 'gold'), 'allow');
  assert.equal(ask('doc:1', 'bronze'), 'deny');
  assert.equal(ask('doc:9', 'gold'), 'deny');
});

test('属性没有的时候，exists 能用，别的比较器一律不成立', () => {
  const missing = {
    id: 'no-deleted',
    effect: 'allow',
    priority: 1,
    subjects: ['*'],
    actions: ['read'],
    resources: ['*'],
    when: { 'resource.deletedAt': { exists: false } },
  };
  assert.equal(read({ subject: 'alice', action: 'read', resource: 'doc:1' }, attributes, missing).effect, 'allow');

  const wrong = { ...missing, id: 'is-deleted', when: { 'resource.deletedAt': { eq: 'x' } } };
  assert.equal(read({ subject: 'alice', action: 'read', resource: 'doc:1' }, attributes, wrong).effect, 'deny');

  const year = { ...missing, id: 'recent', when: { 'resource.year': { gte: 2020 } } };
  assert.equal(read({ subject: 'alice', action: 'read', resource: 'doc:1' }, attributes, year).effect, 'allow');
  assert.equal(read({ subject: 'alice', action: 'read', resource: 'doc:9' }, attributes, year).effect, 'deny');
});

test('命中列表按优先级降序，同优先级按 id 升序', () => {
  const engine = createEngine({
    policies: [
      { id: 'p-low', effect: 'allow', priority: 1, subjects: ['*'], actions: ['*'], resources: ['*'] },
      { id: 'p-high-b', effect: 'allow', priority: 9, subjects: ['*'], actions: ['*'], resources: ['*'] },
      { id: 'p-high-a', effect: 'allow', priority: 9, subjects: ['*'], actions: ['*'], resources: ['*'] },
    ],
    attributes,
  });
  const out = engine.evaluate({ subject: 'alice', action: 'read', resource: 'doc:1' });
  assert.deepEqual(out.matchers, ['p-high-a', 'p-high-b', 'p-low']);
  assert.equal(out.policy, 'p-high-a');
});
