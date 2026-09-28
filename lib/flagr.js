// 灰度开关求值引擎。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/evaluate.test.js、test/rules.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import { FlagError } from './errors.js';

export const DEFAULTS = {
  bucketCount: 1000,
};

const OPERATORS = ['eq', 'in', 'contains', 'startsWith', 'endsWith', 'gt', 'lt', 'exists'];
const REASONS = ['prerequisite', 'rule', 'rollout', 'default'];

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

function fail(code, message, details) {
  throw new FlagError(code, message, details);
}

// README《口径·灰度分桶》：FNV-1a 32 位，按 UTF-8 字节走，键是 "开关名:用户"。
function fnv1a32(text) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(text)) {
    hash = (hash ^ byte) >>> 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function validateCondition(condition) {
  if (!isPlainObject(condition)) fail('ERR_BAD_FLAG', 'condition 必须是对象');
  if (!isNonEmptyString(condition.attribute)) fail('ERR_BAD_FLAG', 'condition.attribute 必须是非空字符串');
  if (!OPERATORS.includes(condition.operator)) fail('ERR_BAD_FLAG', `不支持的 operator: ${condition.operator}`);
  if (condition.operator === 'exists') {
    if (condition.values !== undefined && !Array.isArray(condition.values)) {
      fail('ERR_BAD_FLAG', 'condition.values 必须是数组');
    }
  } else if (!Array.isArray(condition.values)) {
    fail('ERR_BAD_FLAG', 'condition.values 必须是数组');
  }
}

function validateRules(rules, variations) {
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) fail('ERR_BAD_FLAG', 'rules 必须是数组');
  const ids = new Set();
  return rules.map((rule) => {
    if (!isPlainObject(rule)) fail('ERR_BAD_FLAG', 'rule 必须是对象');
    if (!isNonEmptyString(rule.id)) fail('ERR_BAD_FLAG', 'rule.id 必须是非空字符串');
    if (ids.has(rule.id)) fail('ERR_BAD_FLAG', `rule.id 重复: ${rule.id}`);
    ids.add(rule.id);
    const match = rule.match === undefined ? 'all' : rule.match;
    if (match !== 'all' && match !== 'any') fail('ERR_BAD_FLAG', `rule.match 非法: ${rule.match}`);
    const conditions = rule.conditions === undefined ? [] : rule.conditions;
    if (!Array.isArray(conditions)) fail('ERR_BAD_FLAG', 'rule.conditions 必须是数组');
    conditions.forEach(validateCondition);
    if (!variations.includes(rule.serve)) fail('ERR_BAD_FLAG', `rule.serve 不是 variation: ${rule.serve}`);
    return { id: rule.id, match, conditions, serve: rule.serve };
  });
}

function validateRollout(rollout, variations, bucketCount) {
  if (rollout === undefined) return null;
  if (!Array.isArray(rollout)) fail('ERR_BAD_ROLLOUT', 'rollout 必须是数组');
  const seen = new Set();
  let total = 0;
  const entries = rollout.map((entry) => {
    if (!isPlainObject(entry)) fail('ERR_BAD_ROLLOUT', 'rollout 项必须是对象');
    if (!variations.includes(entry.variation)) {
      fail('ERR_BAD_ROLLOUT', `rollout.variation 不是 variation: ${entry.variation}`);
    }
    if (seen.has(entry.variation)) fail('ERR_BAD_ROLLOUT', `rollout.variation 重复: ${entry.variation}`);
    seen.add(entry.variation);
    if (!Number.isInteger(entry.weight) || entry.weight < 0 || entry.weight > bucketCount) {
      fail('ERR_BAD_ROLLOUT', `rollout.weight 必须是 0..${bucketCount} 的整数`);
    }
    total += entry.weight;
    return { variation: entry.variation, weight: entry.weight };
  });
  if (total !== bucketCount) fail('ERR_BAD_ROLLOUT', `rollout 权重之和必须是 ${bucketCount}，实际 ${total}`);
  return entries;
}

function validateRequires(requires, flags) {
  if (requires === undefined) return [];
  if (!Array.isArray(requires)) fail('ERR_BAD_FLAG', 'requires 必须是数组');
  return requires.map((requirement) => {
    if (!isPlainObject(requirement) || !isNonEmptyString(requirement.flag)) {
      fail('ERR_BAD_FLAG', 'requires 项必须是 { flag, variation }');
    }
    const target = flags.get(requirement.flag);
    if (!target) fail('ERR_UNKNOWN_FLAG', `requires 指向未定义的开关: ${requirement.flag}`);
    if (!target.variations.includes(requirement.variation)) {
      fail('ERR_BAD_FLAG', `requires.variation 不在 ${requirement.flag} 的 variations 里`);
    }
    return { flag: requirement.flag, variation: requirement.variation };
  });
}

// 从 key 出发沿 requires 走，能走回 key 就是环（包括指向自己）。
function createsCycle(flags, key) {
  const visited = new Set();
  const queue = [key];
  while (queue.length > 0) {
    const current = flags.get(queue.pop());
    for (const requirement of current ? current.requires : []) {
      if (requirement.flag === key) return true;
      if (!visited.has(requirement.flag)) {
        visited.add(requirement.flag);
        queue.push(requirement.flag);
      }
    }
  }
  return false;
}

function matchCondition(condition, attributes) {
  const has = Object.hasOwn(attributes, condition.attribute);
  const value = attributes[condition.attribute];
  const expected = condition.values === undefined ? [] : condition.values;
  switch (condition.operator) {
    case 'exists':
      return has;
    case 'eq':
      return has && value === expected[0];
    case 'in':
      return has && expected.some((one) => one === value);
    case 'contains':
      return has && typeof value === 'string' && typeof expected[0] === 'string' && value.includes(expected[0]);
    case 'startsWith':
      return has && typeof value === 'string' && typeof expected[0] === 'string' && value.startsWith(expected[0]);
    case 'endsWith':
      return has && typeof value === 'string' && typeof expected[0] === 'string' && value.endsWith(expected[0]);
    case 'gt':
      return has && typeof value === 'number' && typeof expected[0] === 'number' && value > expected[0];
    case 'lt':
      return has && typeof value === 'number' && typeof expected[0] === 'number' && value < expected[0];
    default:
      return false;
  }
}

function matchRule(rule, attributes) {
  const test = (condition) => matchCondition(condition, attributes);
  return rule.match === 'all' ? rule.conditions.every(test) : rule.conditions.some(test);
}

export function createFlagEngine(config = {}) {
  if (!isPlainObject(config)) fail('ERR_BAD_CONFIG', 'config 必须是对象');
  const bucketCount = config.bucketCount === undefined ? DEFAULTS.bucketCount : config.bucketCount;
  if (!Number.isInteger(bucketCount) || bucketCount <= 0) {
    fail('ERR_BAD_CONFIG', 'bucketCount 必须是正整数');
  }

  const flags = new Map();
  const stats = {
    evaluations: 0,
    byReason: { prerequisite: 0, rule: 0, rollout: 0, default: 0 },
  };

  function parseDefinition(definition, existing) {
    if (!isPlainObject(definition)) fail('ERR_BAD_FLAG', '开关定义必须是对象');
    if (!isNonEmptyString(definition.key)) fail('ERR_BAD_FLAG', 'key 必须是非空字符串');
    const { variations } = definition;
    if (!Array.isArray(variations) || variations.length === 0
      || !variations.every(isNonEmptyString) || new Set(variations).size !== variations.length) {
      fail('ERR_BAD_FLAG', 'variations 必须是非空且互不重复的名字数组');
    }
    const offVariation = definition.offVariation === undefined ? null : definition.offVariation;
    if (offVariation !== null && !variations.includes(offVariation)) {
      fail('ERR_BAD_FLAG', `offVariation 不在 variations 里: ${offVariation}`);
    }
    return {
      key: definition.key,
      variations: [...variations],
      offVariation,
      rules: validateRules(definition.rules, variations),
      rollout: validateRollout(definition.rollout, variations, bucketCount),
      requires: validateRequires(definition.requires, existing),
      version: 0,
    };
  }

  function defineFlag(definition) {
    if (!isPlainObject(definition)) fail('ERR_BAD_FLAG', '开关定义必须是对象');
    if (isNonEmptyString(definition.key) && flags.has(definition.key)) {
      fail('ERR_DUPLICATE_FLAG', `开关已定义: ${definition.key}`);
    }
    const flag = parseDefinition(definition, flags);
    flag.version = 1;
    flags.set(flag.key, flag);
    return { key: flag.key, version: flag.version };
  }

  function updateFlag(definition) {
    if (!isPlainObject(definition)) fail('ERR_BAD_FLAG', '开关定义必须是对象');
    const previous = isNonEmptyString(definition.key) ? flags.get(definition.key) : undefined;
    if (!previous) fail('ERR_UNKNOWN_FLAG', `开关未定义: ${definition.key}`);
    const flag = parseDefinition(definition, flags);
    const prospective = new Map(flags);
    prospective.set(flag.key, flag);
    if (createsCycle(prospective, flag.key)) {
      fail('ERR_FLAG_CYCLE', `依赖成环: ${flag.key}`);
    }
    flag.version = previous.version + 1;
    flags.set(flag.key, flag);
    return { key: flag.key, version: flag.version };
  }

  function removeFlag({ key } = {}) {
    if (!flags.has(key)) fail('ERR_UNKNOWN_FLAG', `开关未定义: ${key}`);
    const dependents = [...flags.values()].filter((flag) => flag.requires.some((one) => one.flag === key));
    if (dependents.length > 0) {
      fail('ERR_FLAG_IN_USE', `开关仍被依赖: ${key}`, { by: dependents.map((flag) => flag.key) });
    }
    flags.delete(key);
    return { key, removed: true };
  }

  function normalizeContext(context) {
    if (!isPlainObject(context)) fail('ERR_BAD_CONTEXT', 'context 必须是对象');
    if (!isNonEmptyString(context.userKey)) fail('ERR_BAD_CONTEXT', 'userKey 必须是非空字符串');
    if (context.attributes !== undefined && !isPlainObject(context.attributes)) {
      fail('ERR_BAD_CONTEXT', 'attributes 必须是对象');
    }
    return { userKey: context.userKey, attributes: context.attributes ?? {} };
  }

  // 求值顺序：依赖 → 规则 → 灰度 → 兜底。依赖递归用同一个 context，且不计入统计。
  function resolve(flag, context) {
    for (const requirement of flag.requires) {
      const outcome = resolve(flags.get(requirement.flag), context);
      if (outcome.variation !== requirement.variation) {
        return { variation: flag.offVariation, reason: 'prerequisite', ruleId: null };
      }
    }
    for (const rule of flag.rules) {
      if (matchRule(rule, context.attributes)) {
        return { variation: rule.serve, reason: 'rule', ruleId: rule.id };
      }
    }
    if (flag.rollout !== null) {
      const bucket = fnv1a32(`${flag.key}:${context.userKey}`) % bucketCount;
      let cumulative = 0;
      for (const entry of flag.rollout) {
        cumulative += entry.weight;
        if (bucket < cumulative) return { variation: entry.variation, reason: 'rollout', ruleId: null };
      }
    }
    return { variation: flag.offVariation, reason: 'default', ruleId: null };
  }

  function evaluateOne(flag, context) {
    const outcome = resolve(flag, context);
    stats.evaluations += 1;
    stats.byReason[outcome.reason] += 1;
    return {
      key: flag.key,
      variation: outcome.variation,
      reason: outcome.reason,
      ruleId: outcome.ruleId,
      version: flag.version,
    };
  }

  function evaluate({ key, context } = {}) {
    const normalized = normalizeContext(context);
    const flag = flags.get(key);
    if (!flag) fail('ERR_UNKNOWN_FLAG', `开关未定义: ${key}`);
    return evaluateOne(flag, normalized);
  }

  function evaluateAll({ context } = {}) {
    const normalized = normalizeContext(context);
    return [...flags.keys()].sort().map((key) => evaluateOne(flags.get(key), normalized));
  }

  function list() {
    return [...flags.values()]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((flag) => ({ key: flag.key, version: flag.version, variations: [...flag.variations] }));
  }

  return {
    defineFlag,
    updateFlag,
    removeFlag,
    evaluate,
    evaluateAll,
    list,
    stats: () => ({
      flags: flags.size,
      evaluations: stats.evaluations,
      byReason: { ...stats.byReason },
    }),
  };
}
