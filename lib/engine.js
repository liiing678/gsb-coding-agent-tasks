// 属性化访问决策。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/match|decide|cache）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）和条件求值（lib/conditions.js）
// 都已经按 README 的《口径》和《API》两节写好了。那些约定不要改，把这里补出来。

import { evaluateConditions, ConditionError } from './conditions.js';
import { PolicyError } from './errors.js';

export const DEFAULTS = {
  policies: [],
  attributes: {},
};

const EFFECTS = ['allow', 'deny'];

function badPolicy(message, details) {
  return new PolicyError('ERR_BAD_POLICY', message, details);
}

function badRequest(message, details) {
  return new PolicyError('ERR_BAD_REQUEST', message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatePatternList(field, value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((one) => typeof one !== 'string' || one === '')) {
    throw badPolicy(`${field} 要是非空字符串数组`, { field });
  }
}

function validatePolicy(raw, seen) {
  if (!isPlainObject(raw)) throw badPolicy('策略要写成对象', { field: 'id' });
  const policy = { ...raw };
  if (typeof policy.id !== 'string' || policy.id === '' || seen.has(policy.id)) {
    throw badPolicy(`策略 id 空或重复：${policy.id}`, { field: 'id', value: policy.id });
  }
  seen.add(policy.id);
  if (!EFFECTS.includes(policy.effect)) {
    throw badPolicy(`effect 只能是 allow / deny：${policy.effect}`, { field: 'effect', value: policy.effect });
  }
  if (policy.priority === undefined) {
    policy.priority = 0;
  } else if (!Number.isInteger(policy.priority)) {
    throw badPolicy(`priority 要是整数：${policy.priority}`, { field: 'priority', value: policy.priority });
  }
  for (const field of ['subjects', 'actions', 'resources']) validatePatternList(field, policy[field]);
  if (policy.when !== undefined && policy.when !== null) {
    try {
      evaluateConditions(policy.when, {});
    } catch (err) {
      if (err instanceof ConditionError) {
        throw badPolicy(`when 写得不合法：${err.message}`, { field: 'when', ...err.details });
      }
      throw err;
    }
  }
  if (policy.obligations !== undefined && !isPlainObject(policy.obligations)) {
    throw badPolicy('obligations 要写成对象', { field: 'obligations' });
  }
  return policy;
}

function validatePolicies(list) {
  if (!Array.isArray(list)) throw badPolicy('policies 要是数组', { field: 'id' });
  const seen = new Set();
  return list.map((one) => validatePolicy(one, seen));
}

function validateRequest(request) {
  if (!isPlainObject(request)) throw badRequest('请求要写成对象', {});
  for (const field of ['subject', 'action', 'resource']) {
    if (typeof request[field] !== 'string' || request[field] === '') {
      throw badRequest(`${field} 不能为空`, { field, value: request[field] });
    }
  }
  if (request.context !== undefined && !isPlainObject(request.context)) {
    throw badRequest('context 要写成对象', { field: 'context', value: request.context });
  }
  return {
    subject: request.subject,
    action: request.action,
    resource: request.resource,
    context: request.context ?? {},
  };
}

function cacheKey(request) {
  const context = Object.keys(request.context)
    .sort()
    .map((key) => [key, request.context[key]]);
  return JSON.stringify([request.subject, request.action, request.resource, context]);
}

function matchPattern(pattern, value) {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}

function matchSubject(pattern, id, entry) {
  if (pattern === '*') return true;
  if (pattern.startsWith('role:')) return (entry.roles ?? []).includes(pattern.slice(5));
  if (pattern.startsWith('group:')) return (entry.groups ?? []).includes(pattern.slice(6));
  return pattern === id;
}

function buildScope(request, attributes) {
  const subject = attributes.subjects?.[request.subject];
  if (!isPlainObject(subject)) {
    throw badRequest(`属性表里没有这个主体：${request.subject}`, { field: 'subject', value: request.subject });
  }
  const resource = attributes.resources?.[request.resource];
  if (!isPlainObject(resource)) {
    throw badRequest(`属性表里没有这个资源：${request.resource}`, { field: 'resource', value: request.resource });
  }
  const subjectScope = {};
  for (const role of subject.roles ?? []) Object.assign(subjectScope, attributes.roles?.[role]?.attrs);
  Object.assign(subjectScope, subject.attrs);
  subjectScope.id = request.subject;
  subjectScope.roles = subject.roles ?? [];
  subjectScope.groups = subject.groups ?? [];
  const resourceScope = {};
  Object.assign(resourceScope, attributes.types?.[resource.type]?.attrs);
  Object.assign(resourceScope, resource.attrs);
  resourceScope.id = request.resource;
  resourceScope.type = resource.type;
  resourceScope.tags = resource.tags ?? [];
  return { subject: subjectScope, resource: resourceScope, context: request.context };
}

// 一条策略命中到哪一步；全部通过返回 matched，否则指出第一个不过的环节。
function checkPolicy(policy, request, subjectEntry, scope) {
  const { subject, action, resource } = request;
  if (!policy.subjects.some((one) => matchSubject(one, subject, subjectEntry))) {
    return { matched: false, step: 'subjects' };
  }
  if (!policy.actions.some((one) => matchPattern(one, action))) {
    return { matched: false, step: 'actions' };
  }
  if (!policy.resources.some((one) => matchPattern(one, resource))) {
    return { matched: false, step: 'resources' };
  }
  const conditions = evaluateConditions(policy.when, scope);
  if (!conditions.ok) {
    const failed = conditions.checks.find((one) => !one.ok);
    return { matched: false, step: 'when', path: failed.path, missing: failed.missing };
  }
  return { matched: true };
}

function byPriorityThenId(left, right) {
  return right.priority - left.priority || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function decide(matched) {
  const matchers = matched.map((one) => one.id);
  if (matched.length === 0) {
    return { effect: 'deny', policy: null, priority: null, reason: 'no-match', matchers, obligations: {} };
  }
  const tier = matched.filter((one) => one.priority === matched[0].priority);
  const chosen = tier.find((one) => one.effect === 'deny') ?? tier[0];
  return {
    effect: chosen.effect,
    policy: chosen.id,
    priority: chosen.priority,
    reason: chosen.effect === 'allow' ? 'allow-by-policy' : 'deny-by-policy',
    matchers,
    obligations: chosen.obligations ?? {},
  };
}

export function createEngine(options = {}) {
  let policies = validatePolicies(options.policies ?? DEFAULTS.policies);
  let attributes = options.attributes ?? DEFAULTS.attributes;
  const cache = new Map();
  const stats = { hits: 0, misses: 0 };

  function run(request) {
    const scope = buildScope(request, attributes);
    const subjectEntry = attributes.subjects[request.subject];
    const matched = policies
      .filter((policy) => checkPolicy(policy, request, subjectEntry, scope).matched)
      .sort(byPriorityThenId);
    return decide(matched);
  }

  function evaluate(rawRequest) {
    const request = validateRequest(rawRequest);
    const key = cacheKey(request);
    if (cache.has(key)) {
      stats.hits += 1;
      return cache.get(key);
    }
    stats.misses += 1;
    const decision = run(request);
    cache.set(key, decision);
    return decision;
  }

  function enforce(rawRequest) {
    const decision = evaluate(rawRequest);
    if (decision.effect === 'deny') {
      throw new PolicyError('ERR_ACCESS_DENIED', '访问被拒绝', {
        policy: decision.policy,
        reason: decision.reason,
        matchers: decision.matchers,
      });
    }
    return decision;
  }

  function explain(rawRequest) {
    const request = validateRequest(rawRequest);
    const scope = buildScope(request, attributes);
    const subjectEntry = attributes.subjects[request.subject];
    const lines = [`request ${request.subject} ${request.action} ${request.resource}`];
    const matched = [];
    for (const policy of [...policies].sort(byPriorityThenId)) {
      const head = `policy ${policy.id} ${policy.effect} priority ${policy.priority}`;
      const outcome = checkPolicy(policy, request, subjectEntry, scope);
      if (outcome.matched) {
        lines.push(`${head}: matched`);
        matched.push(policy);
      } else if (outcome.step === 'when') {
        lines.push(`${head}: no-match (when:${outcome.path}${outcome.missing ? ':missing' : ''})`);
      } else {
        lines.push(`${head}: no-match (${outcome.step})`);
      }
    }
    const decision = decide(matched);
    lines.push(`decision: ${decision.effect} by ${decision.policy ?? 'none'}`);
    return lines;
  }

  return {
    evaluate,
    enforce,
    explain,
    setPolicies(next) {
      policies = validatePolicies(next);
      cache.clear();
    },
    setAttributes(next) {
      attributes = next ?? {};
      cache.clear();
    },
    invalidate() {
      const cleared = cache.size;
      cache.clear();
      return cleared;
    },
    cacheStats() {
      return { hits: stats.hits, misses: stats.misses, size: cache.size };
    },
    policies() {
      return policies.map((one) => one.id);
    },
  };
}
