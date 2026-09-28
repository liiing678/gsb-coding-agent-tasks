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

const HUNDRED = [
  { variation: 'on', weight: 500 },
  { variation: 'off', weight: 500 },
];

/** 换一批 userKey 总能碰到落在这两档的人。 */
function userIn(engine, key, wanted, from = 0, to = 200) {
  for (let i = from; i < to; i += 1) {
    const userKey = `u-${i}`;
    if (engine.evaluate({ key, context: { userKey } }).variation === wanted) return userKey;
  }
  throw new Error(`没找到落在 ${wanted} 的用户`);
}

test('没有规则时按灰度分桶，同一个用户每次都落在同一档', () => {
  const engine = createFlagEngine();
  engine.defineFlag({ key: 'checkout', variations: ['on', 'off'], offVariation: 'off', rollout: HUNDRED });
  const userKey = userIn(engine, 'checkout', 'on');
  const first = engine.evaluate({ key: 'checkout', context: { userKey } });
  assert.equal(first.reason, 'rollout');
  assert.equal(first.ruleId, null);
  assert.deepEqual(engine.evaluate({ key: 'checkout', context: { userKey } }), first);
});

test('分桶只看开关名和用户，权重改了不会把人洗牌', () => {
  const engine = createFlagEngine();
  engine.defineFlag({ key: 'checkout', variations: ['on', 'off'], offVariation: 'off', rollout: HUNDRED });
  const staying = userIn(engine, 'checkout', 'on');
  engine.updateFlag({
    key: 'checkout',
    variations: ['on', 'off'],
    offVariation: 'off',
    rollout: [{ variation: 'on', weight: 900 }, { variation: 'off', weight: 100 }],
  });
  const after = engine.evaluate({ key: 'checkout', context: { userKey: staying } });
  assert.equal(after.variation, 'on');
  assert.equal(after.version, 2);
});

test('灰度权重必须是 0..1000 的整数并且加起来正好 1000', () => {
  const engine = createFlagEngine();
  expectError(() => engine.defineFlag({
    key: 'bad', variations: ['on', 'off'], rollout: [{ variation: 'on', weight: 500 }, { variation: 'off', weight: 400 }],
  }), 'ERR_BAD_ROLLOUT');
  expectError(() => engine.defineFlag({
    key: 'bad', variations: ['on', 'off'], rollout: [{ variation: 'on', weight: 1000.5 }],
  }), 'ERR_BAD_ROLLOUT');
  expectError(() => engine.defineFlag({
    key: 'bad', variations: ['on'], rollout: [{ variation: 'nope', weight: 1000 }],
  }), 'ERR_BAD_ROLLOUT');
});

test('规则优先于灰度，按声明顺序第一条命中的说了算', () => {
  const engine = createFlagEngine();
  engine.defineFlag({
    key: 'checkout',
    variations: ['on', 'beta', 'off'],
    offVariation: 'off',
    rules: [
      { id: 'staff', conditions: [{ attribute: 'role', operator: 'eq', values: ['staff'] }], serve: 'beta' },
      { id: 'anyone', conditions: [{ attribute: 'role', operator: 'in', values: ['staff', 'guest'] }], serve: 'on' },
    ],
    rollout: [{ variation: 'off', weight: 1000 }],
  });
  const staff = engine.evaluate({ key: 'checkout', context: { userKey: 'u-1', attributes: { role: 'staff' } } });
  assert.equal(staff.variation, 'beta');
  assert.equal(staff.reason, 'rule');
  assert.equal(staff.ruleId, 'staff');
  const guest = engine.evaluate({ key: 'checkout', context: { userKey: 'u-2', attributes: { role: 'guest' } } });
  assert.equal(guest.ruleId, 'anyone');
  const nobody = engine.evaluate({ key: 'checkout', context: { userKey: 'u-3' } });
  assert.equal(nobody.reason, 'rollout');
  assert.equal(nobody.variation, 'off');
});

test('规则没命中又没有灰度时落到 offVariation', () => {
  const engine = createFlagEngine();
  engine.defineFlag({ key: 'checkout', variations: ['on', 'off'], offVariation: 'off' });
  assert.deepEqual(engine.evaluate({ key: 'checkout', context: { userKey: 'u-1' } }), {
    key: 'checkout', variation: 'off', reason: 'default', ruleId: null, version: 1,
  });
});

test('依赖没满足时开关直接不生效，理由要分得清', () => {
  const engine = createFlagEngine();
  engine.defineFlag({ key: 'base', variations: ['on', 'off'], offVariation: 'off', rollout: [{ variation: 'off', weight: 1000 }] });
  engine.defineFlag({
    key: 'top',
    variations: ['on', 'off'],
    offVariation: 'off',
    requires: [{ flag: 'base', variation: 'on' }],
    rollout: [{ variation: 'on', weight: 1000 }],
  });
  const blocked = engine.evaluate({ key: 'top', context: { userKey: 'u-1' } });
  assert.deepEqual(blocked, { key: 'top', variation: 'off', reason: 'prerequisite', ruleId: null, version: 1 });
  engine.updateFlag({ key: 'base', variations: ['on', 'off'], offVariation: 'off', rollout: [{ variation: 'on', weight: 1000 }] });
  const allowed = engine.evaluate({ key: 'top', context: { userKey: 'u-1' } });
  assert.equal(allowed.variation, 'on');
  assert.equal(allowed.reason, 'rollout');
  assert.equal(engine.stats().byReason.prerequisite, 1);
});

test('evaluateAll 按开关名排序，查询类接口不抛', () => {
  const engine = createFlagEngine();
  engine.defineFlag({ key: 'b', variations: ['on'], offVariation: 'on' });
  engine.defineFlag({ key: 'a', variations: ['on'], offVariation: 'on' });
  assert.deepEqual(engine.evaluateAll({ context: { userKey: 'u-1' } }).map((one) => one.key), ['a', 'b']);
  assert.deepEqual(engine.list(), [
    { key: 'a', version: 1, variations: ['on'] },
    { key: 'b', version: 1, variations: ['on'] },
  ]);
  expectError(() => engine.evaluate({ key: 'nope', context: { userKey: 'u-1' } }), 'ERR_UNKNOWN_FLAG');
});

test('参数不合法时各报哪个码', () => {
  const engine = createFlagEngine();
  expectError(() => engine.defineFlag({ key: '', variations: ['on'] }), 'ERR_BAD_FLAG');
  expectError(() => engine.defineFlag({ key: 'a', variations: [] }), 'ERR_BAD_FLAG');
  expectError(() => engine.defineFlag({ key: 'a', variations: ['on', 'on'] }), 'ERR_BAD_FLAG');
  expectError(() => engine.defineFlag({ key: 'a', variations: ['on'], offVariation: 'nope' }), 'ERR_BAD_FLAG');
  expectError(() => engine.defineFlag({ key: 'a', variations: ['on'], rules: [{ id: '', conditions: [], serve: 'on' }] }), 'ERR_BAD_FLAG');
  expectError(() => engine.defineFlag({ key: 'a', variations: ['on'], rules: [{ id: 'r', match: 'some', conditions: [], serve: 'on' }] }), 'ERR_BAD_FLAG');
  expectError(() => engine.defineFlag({ key: 'a', variations: ['on'], rules: [{ id: 'r', conditions: [], serve: 'nope' }] }), 'ERR_BAD_FLAG');
  engine.defineFlag({ key: 'a', variations: ['on'] });
  expectError(() => engine.defineFlag({ key: 'a', variations: ['on'] }), 'ERR_DUPLICATE_FLAG');
  expectError(() => engine.updateFlag({ key: 'nope', variations: ['on'] }), 'ERR_UNKNOWN_FLAG');
  expectError(() => engine.evaluate({ key: 'a', context: { userKey: '' } }), 'ERR_BAD_CONTEXT');
  expectError(() => engine.evaluate({ key: 'a', context: null }), 'ERR_BAD_CONTEXT');
  expectError(() => engine.evaluate({ key: 'a' }), 'ERR_BAD_CONTEXT');
  expectError(() => createFlagEngine(null), 'ERR_BAD_CONFIG');
});
