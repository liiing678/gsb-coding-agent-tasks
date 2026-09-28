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
  roles: { editor: { attrs: { canEdit: true } } },
  types: { doc: { attrs: { kind: 'content' } } },
};

const policies = [
  {
    id: 'deny-secret',
    effect: 'deny',
    priority: 5,
    subjects: ['*'],
    actions: ['read'],
    resources: ['*'],
    when: { 'resource.tags': { has: 'secret' } },
  },
  {
    id: 'editors-recent',
    effect: 'allow',
    priority: 5,
    subjects: ['role:editor'],
    actions: ['read'],
    resources: ['doc:*'],
    when: { 'resource.year': { gte: 2020 } },
    obligations: { mask: ['ssn'] },
  },
  {
    id: 'auditor-old',
    effect: 'allow',
    priority: 9,
    subjects: ['group:staff'],
    actions: ['read'],
    resources: ['*'],
    when: { 'context.tier': { in: ['gold', 'silver'] } },
  },
];

const engine = createEngine({ policies, attributes });
const show = (request) => {
  const out = engine.evaluate(request);
  console.log(`    ${request.action} ${request.resource}: ${out.effect} by ${out.policy ?? 'none'} (${out.reason})`);
  if (out.matchers.length > 0) console.log(`      matchers ${out.matchers.join(',')}`);
  if (Object.keys(out.obligations).length > 0) {
    console.log(`      obligations ${JSON.stringify(out.obligations)}`);
  }
};

console.log('policygate demo');

console.log('[1] 编辑看自己部门近两年的公开文档');
show({ subject: 'alice', action: 'read', resource: 'doc:1' });

console.log('[2] 同一个人去碰标着 secret 的文档，被那条 deny 拦住');
show({ subject: 'alice', action: 'read', resource: 'doc:9' });

console.log('[3] 带上 gold，优先级更高的那条 allow 压过同档的 deny');
show({ subject: 'alice', action: 'read', resource: 'doc:9', context: { tier: 'gold' } });

console.log('[4] 换成 bob：staff 那条轮不到他，同一档里 deny 赢');
show({ subject: 'bob', action: 'read', resource: 'doc:9', context: { tier: 'gold' } });

console.log('[5] 谁也没命中就是默认拒绝，explain 一行行摊开');
for (const line of engine.explain({ subject: 'bob', action: 'read', resource: 'doc:1' })) {
  console.log(`    ${line}`);
}

console.log('[6] 同一个请求第二次走缓存');
engine.evaluate({ subject: 'alice', action: 'read', resource: 'doc:1' });
const stats = engine.cacheStats();
console.log(`    hits=${stats.hits} misses=${stats.misses} size=${stats.size}`);
