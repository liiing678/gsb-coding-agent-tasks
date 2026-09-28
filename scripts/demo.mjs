import { createFlagEngine } from '../lib/flagr.js';

const engine = createFlagEngine();
const show = (label, value) => console.log(`    ${label} ${value}`);
const result = (one) => `${one.variation} (${one.reason}${one.ruleId ? ':' + one.ruleId : ''}) v${one.version}`;

console.log('flagr demo');

console.log('[1] 定义一个 50/50 的灰度开关');
show('define', JSON.stringify(engine.defineFlag({
  key: 'checkout',
  variations: ['on', 'off'],
  offVariation: 'off',
  rollout: [{ variation: 'on', weight: 500 }, { variation: 'off', weight: 500 }],
})));

console.log('[2] 同一个用户每次都落在同一档');
const picked = pickUser(engine, 'on');
show('evaluate', `${picked.userKey} -> ${result(picked.result)}`);
show('evaluate', `${picked.userKey} -> ${result(engine.evaluate({ key: 'checkout', context: { userKey: picked.userKey } }))}`);

console.log('[3] 权重从 50/50 改成 90/10，已经命中的人不会掉出去');
engine.updateFlag({
  key: 'checkout',
  variations: ['on', 'off'],
  offVariation: 'off',
  rollout: [{ variation: 'on', weight: 900 }, { variation: 'off', weight: 100 }],
});
show('evaluate', `${picked.userKey} -> ${result(engine.evaluate({ key: 'checkout', context: { userKey: picked.userKey } }))}`);

console.log('[4] 规则优先于灰度');
engine.updateFlag({
  key: 'checkout',
  variations: ['on', 'off', 'beta'],
  offVariation: 'off',
  rules: [{ id: 'staff', conditions: [{ attribute: 'role', operator: 'eq', values: ['staff'] }], serve: 'beta' }],
  rollout: [{ variation: 'on', weight: 900 }, { variation: 'off', weight: 100 }],
});
show('evaluate', `staff -> ${result(engine.evaluate({ key: 'checkout', context: { userKey: 'u-7', attributes: { role: 'staff' } } }))}`);
show('evaluate', `guest -> ${result(engine.evaluate({ key: 'checkout', context: { userKey: 'u-7' } }))}`);

console.log('[5] 依赖没满足，开关直接不生效');
engine.defineFlag({ key: 'billing', variations: ['on', 'off'], offVariation: 'off', rollout: [{ variation: 'off', weight: 1000 }] });
engine.defineFlag({
  key: 'billing-v2',
  variations: ['on', 'off'],
  offVariation: 'off',
  requires: [{ flag: 'billing', variation: 'on' }],
  rollout: [{ variation: 'on', weight: 1000 }],
});
show('evaluate', `billing -> ${result(engine.evaluate({ key: 'billing', context: { userKey: 'u-1' } }))}`);
show('evaluate', `billing-v2 -> ${result(engine.evaluate({ key: 'billing-v2', context: { userKey: 'u-1' } }))}`);

console.log('[6] 统计');
console.log(`    ${JSON.stringify(engine.stats())}`);

function pickUser(instance, wanted) {
  for (let i = 0; i < 200; i += 1) {
    const userKey = `u-${i}`;
    const one = instance.evaluate({ key: 'checkout', context: { userKey } });
    if (one.variation === wanted) return { userKey, result: one };
  }
  throw new Error('没找到合适的用户');
}
