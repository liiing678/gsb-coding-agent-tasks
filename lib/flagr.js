// 灰度开关求值引擎：求值顺序固定为 依赖 → 规则 → 灰度 → 兜底。

import { FlagError } from './errors.js';

export const DEFAULTS = {
  bucketCount: 1000,
};

const OPERATORS = new Set(['eq', 'in', 'contains', 'startsWith', 'endsWith', 'gt', 'lt', 'exists']);

export function createFlagEngine(config = {}) {
  if (!isObject(config)) {
    throw new FlagError('ERR_BAD_CONFIG', 'config 必须是对象');
  }
  const bucketCount = config.bucketCount === undefined ? DEFAULTS.bucketCount : config.bucketCount;
  if (!Number.isInteger(bucketCount) || bucketCount <= 0) {
    throw new FlagError('ERR_BAD_CONFIG', 'bucketCount 必须是正整数');
  }

  const flags = new Map();
  const counters = {
    evaluations: 0,
    byReason: { prerequisite: 0, rule: 0, rollout: 0, default: 0 },
  };

  function defineFlag(spec) {
    if (!isObject(spec) || !isNonEmptyString(spec.key)) {
      throw new FlagError('ERR_BAD_FLAG', 'key 必须是非空字符串');
    }
    if (flags.has(spec.key)) {
      throw new FlagError('ERR_DUPLICATE_FLAG', `开关 ${spec.key} 已经定义过`, { key: spec.key });
    }
    const normalized = normalizeSpec(spec);
    flags.set(spec.key, { ...normalized, version: 1 });
    return { key: spec.key, version: 1 };
  }

  function updateFlag(spec) {
    if (!isObject(spec) || !isNonEmptyString(spec.key)) {
      throw new FlagError('ERR_BAD_FLAG', 'key 必须是非空字符串');
    }
    const current = flags.get(spec.key);
    if (!current) {
      throw new FlagError('ERR_UNKNOWN_FLAG', `开关 ${spec.key} 还没定义`, { key: spec.key });
    }
    const normalized = normalizeSpec(spec);
    if (hasCycle(spec.key, normalized.requires)) {
      throw new FlagError('ERR_FLAG_CYCLE', `开关 ${spec.key} 的依赖成环`, { key: spec.key });
    }
    const version = current.version + 1;
    flags.set(spec.key, { ...normalized, version });
    return { key: spec.key, version };
  }

  function removeFlag(input) {
    const key = isObject(input) ? input.key : undefined;
    if (!isNonEmptyString(key) || !flags.has(key)) {
      throw new FlagError('ERR_UNKNOWN_FLAG', `开关 ${key} 还没定义`, { key });
    }
    const by = [];
    for (const [otherKey, flag] of flags) {
      if (otherKey !== key && flag.requires.some((one) => one.flag === key)) {
        by.push(otherKey);
      }
    }
    if (by.length > 0) {
      throw new FlagError('ERR_FLAG_IN_USE', `开关 ${key} 还被别的开关依赖着`, { key, by });
    }
    flags.delete(key);
    return { key, removed: true };
  }

  function evaluate(input) {
    const key = isObject(input) ? input.key : undefined;
    const context = normalizeContext(isObject(input) ? input.context : input);
    const flag = flags.get(key);
    if (!flag) {
      throw new FlagError('ERR_UNKNOWN_FLAG', `开关 ${key} 还没定义`, { key });
    }
    const outcome = evaluateFlag(flag, context);
    counters.evaluations += 1;
    counters.byReason[outcome.reason] += 1;
    return outcome;
  }

  function evaluateAll(input) {
    const context = normalizeContext(isObject(input) ? input.context : input);
    return [...flags.values()]
      .sort(compareByKey)
      .map((flag) => evaluateFlag(flag, context));
  }

  function list() {
    return [...flags.values()]
      .sort(compareByKey)
      .map((flag) => ({ key: flag.key, version: flag.version, variations: flag.variations }));
  }

  function stats() {
    return {
      flags: flags.size,
      evaluations: counters.evaluations,
      byReason: { ...counters.byReason },
    };
  }

  function normalizeSpec(spec) {
    if (!Array.isArray(spec.variations) || spec.variations.length === 0) {
      throw new FlagError('ERR_BAD_FLAG', 'variations 必须是非空数组', { key: spec.key });
    }
    const variationSet = new Set();
    for (const variation of spec.variations) {
      if (!isNonEmptyString(variation) || variationSet.has(variation)) {
        throw new FlagError('ERR_BAD_FLAG', 'variations 必须是互不重复的非空字符串', { key: spec.key });
      }
      variationSet.add(variation);
    }

    const offVariation = spec.offVariation === undefined ? null : spec.offVariation;
    if (offVariation !== null && !variationSet.has(offVariation)) {
      throw new FlagError('ERR_BAD_FLAG', 'offVariation 必须是 variations 之一或 null', { key: spec.key });
    }

    const rules = normalizeRules(spec.rules, variationSet, spec.key);
    const requires = normalizeRequires(spec.requires, spec.key);
    const rollout = normalizeRollout(spec.rollout, variationSet, spec.key);

    return { key: spec.key, variations: [...spec.variations], offVariation, rules, requires, rollout };
  }

  function normalizeRules(rules, variationSet, key) {
    if (rules === undefined) return [];
    if (!Array.isArray(rules)) {
      throw new FlagError('ERR_BAD_FLAG', 'rules 必须是数组', { key });
    }
    const ids = new Set();
    return rules.map((rule) => {
      if (!isObject(rule) || !isNonEmptyString(rule.id) || ids.has(rule.id)) {
        throw new FlagError('ERR_BAD_FLAG', '规则 id 非空且同一个开关里不能重名', { key });
      }
      ids.add(rule.id);
      const match = rule.match === undefined ? 'all' : rule.match;
      if (match !== 'all' && match !== 'any') {
        throw new FlagError('ERR_BAD_FLAG', "match 只能是 'all' 或 'any'", { key, ruleId: rule.id });
      }
      if (!Array.isArray(rule.conditions)) {
        throw new FlagError('ERR_BAD_FLAG', 'conditions 必须是数组', { key, ruleId: rule.id });
      }
      const conditions = rule.conditions.map((condition) => {
        if (!isObject(condition) || !isNonEmptyString(condition.attribute)) {
          throw new FlagError('ERR_BAD_FLAG', 'condition.attribute 必须是非空字符串', { key, ruleId: rule.id });
        }
        if (!OPERATORS.has(condition.operator)) {
          throw new FlagError('ERR_BAD_FLAG', `不支持的算子 ${condition.operator}`, { key, ruleId: rule.id });
        }
        let values = condition.values;
        if (values === undefined) {
          if (condition.operator !== 'exists') {
            throw new FlagError('ERR_BAD_FLAG', 'values 必须是数组', { key, ruleId: rule.id });
          }
          values = [];
        }
        if (!Array.isArray(values)) {
          throw new FlagError('ERR_BAD_FLAG', 'values 必须是数组', { key, ruleId: rule.id });
        }
        return { attribute: condition.attribute, operator: condition.operator, values: [...values] };
      });
      if (!variationSet.has(rule.serve)) {
        throw new FlagError('ERR_BAD_FLAG', '规则的 serve 必须是 variations 之一', { key, ruleId: rule.id });
      }
      return { id: rule.id, match, conditions, serve: rule.serve };
    });
  }

  function normalizeRequires(requires, key) {
    if (requires === undefined) return [];
    if (!Array.isArray(requires)) {
      throw new FlagError('ERR_BAD_FLAG', 'requires 必须是数组', { key });
    }
    return requires.map((one) => {
      if (!isObject(one) || !isNonEmptyString(one.flag) || !isNonEmptyString(one.variation)) {
        throw new FlagError('ERR_BAD_FLAG', 'requires 每项必须是 { flag, variation }', { key });
      }
      const target = flags.get(one.flag);
      if (!target) {
        throw new FlagError('ERR_UNKNOWN_FLAG', `依赖的开关 ${one.flag} 还没定义`, { key, requires: one.flag });
      }
      if (!target.variations.includes(one.variation)) {
        throw new FlagError('ERR_BAD_FLAG', `依赖的 variation ${one.variation} 不存在`, { key, requires: one.flag });
      }
      return { flag: one.flag, variation: one.variation };
    });
  }

  function normalizeRollout(rollout, variationSet, key) {
    if (rollout === undefined) return null;
    if (!Array.isArray(rollout)) {
      throw new FlagError('ERR_BAD_ROLLOUT', 'rollout 必须是数组', { key });
    }
    const used = new Set();
    let total = 0;
    const normalized = rollout.map((entry) => {
      if (!isObject(entry) || !variationSet.has(entry.variation) || used.has(entry.variation)) {
        throw new FlagError('ERR_BAD_ROLLOUT', 'rollout 的 variation 必须存在且不重复', { key });
      }
      used.add(entry.variation);
      if (!Number.isInteger(entry.weight) || entry.weight < 0 || entry.weight > bucketCount) {
        throw new FlagError('ERR_BAD_ROLLOUT', `weight 必须是 0..${bucketCount} 的整数`, { key });
      }
      total += entry.weight;
      return { variation: entry.variation, weight: entry.weight };
    });
    if (total !== bucketCount) {
      throw new FlagError('ERR_BAD_ROLLOUT', `权重加起来必须正好是 ${bucketCount}`, { key, total });
    }
    return normalized;
  }

  // 更新时先把 startKey 的依赖替换成 nextRequires 再 DFS，指向自己的环也能查到。
  function hasCycle(startKey, nextRequires) {
    const onStack = new Set();
    const done = new Set();
    const visit = (flagKey) => {
      if (onStack.has(flagKey)) return true;
      if (done.has(flagKey)) return false;
      onStack.add(flagKey);
      const requires = flagKey === startKey ? nextRequires : flags.get(flagKey).requires;
      for (const one of requires) {
        if (visit(one.flag)) return true;
      }
      onStack.delete(flagKey);
      done.add(flagKey);
      return false;
    };
    return visit(startKey);
  }

  function evaluateFlag(flag, context) {
    for (const prerequisite of flag.requires) {
      const depOutcome = evaluateFlag(flags.get(prerequisite.flag), context);
      if (depOutcome.variation !== prerequisite.variation) {
        return makeOutcome(flag, flag.offVariation, 'prerequisite');
      }
    }

    for (const rule of flag.rules) {
      if (matchRule(rule, context.attributes)) {
        return makeOutcome(flag, rule.serve, 'rule', rule.id);
      }
    }

    if (flag.rollout !== null) {
      const bucket = fnv1a32(`${flag.key}:${context.userKey}`) % bucketCount;
      let cumulative = 0;
      for (const entry of flag.rollout) {
        cumulative += entry.weight;
        if (bucket < cumulative) {
          return makeOutcome(flag, entry.variation, 'rollout');
        }
      }
    }

    return makeOutcome(flag, flag.offVariation, 'default');
  }

  return { defineFlag, updateFlag, removeFlag, evaluate, evaluateAll, list, stats };
}

function compareByKey(a, b) {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function normalizeContext(context) {
  if (!isObject(context)) {
    throw new FlagError('ERR_BAD_CONTEXT', 'context 必须是对象');
  }
  if (!isNonEmptyString(context.userKey)) {
    throw new FlagError('ERR_BAD_CONTEXT', 'userKey 必须是非空字符串');
  }
  const attributes = context.attributes === undefined ? {} : context.attributes;
  if (!isObject(attributes)) {
    throw new FlagError('ERR_BAD_CONTEXT', 'attributes 必须是对象');
  }
  return { userKey: context.userKey, attributes };
}

function makeOutcome(flag, variation, reason, ruleId = null) {
  return { key: flag.key, variation, reason, ruleId, version: flag.version };
}

function matchRule(rule, attributes) {
  const results = rule.conditions.map((condition) => matchCondition(condition, attributes));
  return rule.match === 'all' ? results.every(Boolean) : results.some(Boolean);
}

function matchCondition(condition, attributes) {
  const present = Object.prototype.hasOwnProperty.call(attributes, condition.attribute);
  if (condition.operator === 'exists') {
    return present;
  }
  if (!present) {
    return false;
  }
  const value = attributes[condition.attribute];
  const target = condition.values[0];
  switch (condition.operator) {
    case 'eq':
      return value === target;
    case 'in':
      return condition.values.includes(value);
    case 'contains':
      return typeof value === 'string' && typeof target === 'string' && value.includes(target);
    case 'startsWith':
      return typeof value === 'string' && typeof target === 'string' && value.startsWith(target);
    case 'endsWith':
      return typeof value === 'string' && typeof target === 'string' && value.endsWith(target);
    case 'gt':
      return typeof value === 'number' && typeof target === 'number' && value > target;
    case 'lt':
      return typeof value === 'number' && typeof target === 'number' && value < target;
    default:
      return false;
  }
}

// 一字不差的 FNV-1a 32 位：按 UTF-8 字节走，key 是 `${开关名}:${userKey}`。
function fnv1a32(input) {
  let h = 2166136261;
  for (const byte of new TextEncoder().encode(input)) {
    h = (h ^ byte) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
