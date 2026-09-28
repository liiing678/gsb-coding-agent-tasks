// 属性化访问决策。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/match|decide|cache）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）和条件求值（lib/conditions.js）
// 都已经按 README 的《口径》和《API》两节写好了。那些约定不要改，把这里补出来。

import { PolicyError } from './errors.js';
import { evaluateConditions } from './conditions.js';

export const DEFAULTS = {
  policies: [],
  attributes: {},
};

export function createEngine(options = {}) {
  const settings = { ...DEFAULTS, ...options };

  let policies = normalizePolicies(settings.policies);
  let attributes = settings.attributes ?? {};
  let cache = new Map();
  let hits = 0;
  let misses = 0;

  function orderedPolicies() {
    return policies
      .slice()
      .sort((left, right) =>
        right.priority - left.priority || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      );
  }

  function buildScope(request) {
    const subjectEntry = attributes.subjects?.[request.subject];
    if (!subjectEntry) {
      throw new PolicyError('ERR_BAD_REQUEST', `主体在属性表里没有：${request.subject}`, {
        field: 'subject',
        value: request.subject,
      });
    }
    const resourceEntry = attributes.resources?.[request.resource];
    if (!resourceEntry) {
      throw new PolicyError('ERR_BAD_REQUEST', `资源在属性表里没有：${request.resource}`, {
        field: 'resource',
        value: request.resource,
      });
    }

    const subject = {};
    for (const roleName of subjectEntry.roles ?? []) {
      Object.assign(subject, attributes.roles?.[roleName]?.attrs ?? {});
    }
    Object.assign(subject, subjectEntry.attrs ?? {});
    subject.id = request.subject;
    subject.roles = subjectEntry.roles ?? [];
    subject.groups = subjectEntry.groups ?? [];

    const resource = {};
    Object.assign(resource, attributes.types?.[resourceEntry.type]?.attrs ?? {});
    Object.assign(resource, resourceEntry.attrs ?? {});
    resource.id = request.resource;
    resource.type = resourceEntry.type;
    resource.tags = resourceEntry.tags ?? [];

    return { subject, resource, context: request.context ?? {} };
  }

  function matchToken(token, value) {
    if (token === '*') return true;
    if (token.endsWith('*')) return value.startsWith(token.slice(0, -1));
    return token === value;
  }

  function matchAny(list, value) {
    return list.some((token) => matchToken(token, value));
  }

  function subjectMatches(policy, subject) {
    return policy.subjects.some((token) => {
      if (token === '*') return true;
      if (token.startsWith('role:')) return subject.roles.includes(token.slice('role:'.length));
      if (token.startsWith('group:')) return subject.groups.includes(token.slice('group:'.length));
      return token === subject.id;
    });
  }

  // 返回命中的策略（已按优先级降序、id 升序），以及每条策略的判定明细。
  function runPolicies(scope, request) {
    const lines = [];
    const matched = [];
    for (const policy of orderedPolicies()) {
      if (!subjectMatches(policy, scope.subject)) {
        lines.push({ policy, matched: false, stage: 'subjects' });
        continue;
      }
      if (!matchAny(policy.actions, request.action)) {
        lines.push({ policy, matched: false, stage: 'actions' });
        continue;
      }
      if (!matchAny(policy.resources, request.resource)) {
        lines.push({ policy, matched: false, stage: 'resources' });
        continue;
      }
      const outcome = evaluateConditions(policy.when, scope);
      if (!outcome.ok) {
        const failed = outcome.checks.find((check) => !check.ok);
        lines.push({
          policy,
          matched: false,
          stage: 'when',
          path: failed.path,
          missing: failed.missing,
        });
        continue;
      }
      lines.push({ policy, matched: true });
      matched.push(policy);
    }
    return { matched, lines };
  }

  function decide(matched) {
    if (matched.length === 0) {
      return {
        effect: 'deny',
        policy: null,
        priority: null,
        reason: 'no-match',
        matchers: [],
        obligations: {},
      };
    }
    const topPriority = matched[0].priority;
    const top = matched.filter((policy) => policy.priority === topPriority);
    const winner = top.find((policy) => policy.effect === 'deny') ?? top[0];
    return {
      effect: winner.effect,
      policy: winner.id,
      priority: winner.priority,
      reason: winner.effect === 'deny' ? 'deny-by-policy' : 'allow-by-policy',
      matchers: matched.map((policy) => policy.id),
      obligations: winner.obligations ? { ...winner.obligations } : {},
    };
  }

  function validateRequest(request) {
    if (!request || typeof request !== 'object') {
      throw new PolicyError('ERR_BAD_REQUEST', '请求要写成对象', { field: 'request' });
    }
    for (const field of ['subject', 'action', 'resource']) {
      if (typeof request[field] !== 'string' || request[field].length === 0) {
        throw new PolicyError('ERR_BAD_REQUEST', `${field} 不能为空`, {
          field,
          value: request[field],
        });
      }
    }
    if (request.context !== undefined && (typeof request.context !== 'object' || request.context === null || Array.isArray(request.context))) {
      throw new PolicyError('ERR_BAD_REQUEST', 'context 要写成对象', { field: 'context' });
    }
  }

  function cacheKey(request) {
    const context = request.context ?? {};
    const contextJson = `{${Object.keys(context)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${JSON.stringify(context[key])}`)
      .join(',')}}`;
    return `${request.subject}\u0000${request.action}\u0000${request.resource}\u0000${contextJson}`;
  }

  function compute(request) {
    const scope = buildScope(request);
    const { matched } = runPolicies(scope, request);
    return decide(matched);
  }

  function clearCache() {
    const removed = cache.size;
    cache = new Map();
    return removed;
  }

  return {
    evaluate(request) {
      validateRequest(request);
      const key = cacheKey(request);
      if (cache.has(key)) {
        hits += 1;
        return cache.get(key);
      }
      misses += 1;
      const result = compute(request);
      cache.set(key, result);
      return result;
    },

    enforce(request) {
      const result = this.evaluate(request);
      if (result.effect === 'deny') {
        throw new PolicyError('ERR_ACCESS_DENIED', `访问被拒绝：${result.reason}`, {
          policy: result.policy,
          reason: result.reason,
          matchers: result.matchers,
        });
      }
      return result;
    },

    explain(request) {
      validateRequest(request);
      const scope = buildScope(request);
      const { lines } = runPolicies(scope, request);
      const matched = lines.filter((line) => line.matched).map((line) => line.policy);
      const result = decide(matched);
      const output = [`request ${request.subject} ${request.action} ${request.resource}`];
      for (const line of lines) {
        const head = `policy ${line.policy.id} ${line.policy.effect} priority ${line.policy.priority}`;
        if (line.matched) {
          output.push(`${head}: matched`);
        } else if (line.stage === 'when') {
          const suffix = line.missing ? `:${line.path}:missing` : `:${line.path}`;
          output.push(`${head}: no-match (when${suffix})`);
        } else {
          output.push(`${head}: no-match (${line.stage})`);
        }
      }
      output.push(`decision: ${result.effect} by ${result.policy ?? 'none'}`);
      return output;
    },

    setPolicies(nextPolicies) {
      policies = normalizePolicies(nextPolicies);
      clearCache();
    },

    setAttributes(nextAttributes) {
      attributes = nextAttributes ?? {};
      clearCache();
    },

    invalidate() {
      return clearCache();
    },

    cacheStats() {
      return { hits, misses, size: cache.size };
    },

    policies() {
      return policies.map((policy) => policy.id);
    },
  };
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0);
}

function badPolicy(message, details) {
  return new PolicyError('ERR_BAD_POLICY', message, details);
}

function normalizePolicies(rawPolicies) {
  if (!Array.isArray(rawPolicies)) {
    throw badPolicy('policies 要写成数组', { field: 'policies' });
  }
  const seen = new Set();
  return rawPolicies.map((policy) => normalizePolicy(policy, seen));
}

function normalizePolicy(policy, seen) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw badPolicy('策略要写成对象', { field: 'policy' });
  }
  if (typeof policy.id !== 'string' || policy.id.length === 0) {
    throw badPolicy('策略 id 必须是非空字符串', { field: 'id', value: policy.id });
  }
  if (seen.has(policy.id)) {
    throw badPolicy(`策略 id 重复：${policy.id}`, { field: 'id', value: policy.id });
  }
  if (policy.effect !== 'allow' && policy.effect !== 'deny') {
    throw badPolicy(`effect 只能是 allow / deny：${policy.effect}`, {
      field: 'effect',
      value: policy.effect,
    });
  }
  if (policy.priority !== undefined && !Number.isInteger(policy.priority)) {
    throw badPolicy(`priority 必须是整数：${policy.priority}`, {
      field: 'priority',
      value: policy.priority,
    });
  }
  for (const field of ['subjects', 'actions', 'resources']) {
    if (!isNonEmptyStringArray(policy[field])) {
      throw badPolicy(`${field} 必须是非空字符串数组`, { field });
    }
  }
  if (policy.when !== undefined && policy.when !== null) {
    try {
      evaluateConditions(policy.when, {});
    } catch (err) {
      if (err?.code === 'ERR_BAD_POLICY') {
        throw badPolicy(err.message, { field: 'when', ...err.details });
      }
      throw err;
    }
  }
  if (
    policy.obligations !== undefined &&
    (typeof policy.obligations !== 'object' || policy.obligations === null || Array.isArray(policy.obligations))
  ) {
    throw badPolicy('obligations 必须是对象', { field: 'obligations' });
  }

  seen.add(policy.id);
  return {
    id: policy.id,
    effect: policy.effect,
    priority: policy.priority ?? 0,
    subjects: policy.subjects.slice(),
    actions: policy.actions.slice(),
    resources: policy.resources.slice(),
    when: policy.when ?? null,
    obligations: policy.obligations ? { ...policy.obligations } : {},
  };
}
