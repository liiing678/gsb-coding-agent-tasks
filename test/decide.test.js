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

const allow = (id, priority, extra = {}) => ({
  id,
  effect: 'allow',
  priority,
  subjects: ['*'],
  actions: ['read'],
  resources: ['*'],
  ...extra,
});

test('优先级高的那条说了算', () => {
  const engine = createEngine({
    policies: [
      { ...allow('deny-ish', 9), effect: 'deny' },
      allow('open', 5),
    ],
    attributes,
  });
  const out = engine.evaluate({ subject: 'bob', action: 'read', resource: 'doc:9' });
  assert.deepEqual(
    { effect: out.effect, policy: out.policy, reason: out.reason, priority: out.priority },
    { effect: 'deny', policy: 'deny-ish', reason: 'deny-by-policy', priority: 9 },
  );
  assert.deepEqual(out.matchers, ['deny-ish', 'open']);
});

test('优先级一样的时候拒绝赢', () => {
  const engine = createEngine({
    policies: [allow('open', 5), { ...allow('shut', 5), effect: 'deny' }],
    attributes,
  });
  const out = engine.evaluate({ subject: 'bob', action: 'read', resource: 'doc:9' });
  assert.equal(out.effect, 'deny');
  assert.equal(out.policy, 'shut');
});

test('一条都没命中就是默认拒绝', () => {
  const engine = createEngine({ policies: [allow('editors', 1, { subjects: ['role:editor'] })], attributes });
  const out = engine.evaluate({ subject: 'bob', action: 'read', resource: 'doc:1' });
  assert.deepEqual(out, {
    effect: 'deny',
    policy: null,
    priority: null,
    reason: 'no-match',
    matchers: [],
    obligations: {},
  });
});

test('定下来的那条策略的 obligations 原样带出来', () => {
  const engine = createEngine({
    policies: [allow('masked', 5, { obligations: { mask: ['ssn'], log: true } })],
    attributes,
  });
  const out = engine.evaluate({ subject: 'alice', action: 'read', resource: 'doc:1' });
  assert.deepEqual(out.obligations, { mask: ['ssn'], log: true });
});

test('enforce 放行就返回决策，拒绝就抛 ERR_ACCESS_DENIED', () => {
  const engine = createEngine({ policies: [allow('open', 5, { subjects: ['role:editor'] })], attributes });
  const out = engine.enforce({ subject: 'alice', action: 'read', resource: 'doc:1' });
  assert.equal(out.effect, 'allow');

  const err = expectError(
    () => engine.enforce({ subject: 'bob', action: 'read', resource: 'doc:9' }),
    'ERR_ACCESS_DENIED',
  );
  assert.equal(err.details.reason, 'no-match');
  assert.equal(err.details.policy, null);
});

test('explain 把每条策略为什么算/不算说清楚', () => {
  const engine = createEngine({
    policies: [
      allow('recent', 5, { when: { 'resource.year': { gte: 2020 } } }),
      { ...allow('deny-secret', 5), effect: 'deny', subjects: ['*'], when: { 'resource.tags': { has: 'secret' } } },
    ],
    attributes,
  });
  assert.deepEqual(engine.explain({ subject: 'alice', action: 'read', resource: 'doc:1' }), [
    'request alice read doc:1',
    'policy deny-secret deny priority 5: no-match (when:resource.tags)',
    'policy recent allow priority 5: matched',
    'decision: allow by recent',
  ]);
  assert.deepEqual(engine.explain({ subject: 'alice', action: 'write', resource: 'doc:1' }), [
    'request alice write doc:1',
    'policy deny-secret deny priority 5: no-match (actions)',
    'policy recent allow priority 5: no-match (actions)',
    'decision: deny by none',
  ]);
});

test('条件里属性没有的时候，explain 里能看到是缺东西', () => {
  const engine = createEngine({
    policies: [allow('not-deleted', 5, { when: { 'resource.deletedAt': { eq: null } } })],
    attributes,
  });
  assert.deepEqual(engine.explain({ subject: 'alice', action: 'read', resource: 'doc:1' }), [
    'request alice read doc:1',
    'policy not-deleted allow priority 5: no-match (when:resource.deletedAt:missing)',
    'decision: deny by none',
  ]);
});
