// 条件求值：从作用域里按路径取属性，拿比较器判真假。
// 策略怎么组合、优先级谁大谁小，都不在这个文件里。

export const OPERATORS = ['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'has', 'notHas', 'exists'];

const PATH_RE = /^(subject|resource|context)\.([A-Za-z_][A-Za-z0-9_]*)$/;

export class ConditionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ConditionError';
    this.code = 'ERR_BAD_POLICY';
    this.details = details;
  }
}

// 'subject.level' -> { scope: 'subject', attr: 'level' }
export function parseConditionPath(path) {
  const matched = typeof path === 'string' ? PATH_RE.exec(path) : null;
  if (!matched) {
    throw new ConditionError(`条件路径要写成 subject.x / resource.x / context.x：${path}`, { path });
  }
  return { scope: matched[1], attr: matched[2] };
}

// 一条条件：同一个路径下的多个比较器是"且"。
export function evaluateCondition(path, spec, scope) {
  const { scope: where, attr } = parseConditionPath(path);
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new ConditionError(`${path} 的条件要写成对象`, { path });
  }
  const bag = scope?.[where] ?? {};
  const missing = !Object.prototype.hasOwnProperty.call(bag, attr);
  const value = bag[attr];
  const checks = [];
  for (const [op, expected] of Object.entries(spec)) {
    if (!OPERATORS.includes(op)) {
      throw new ConditionError(`不认识的比较器：${op}`, { path, op });
    }
    checkExpected(op, expected, path);
    checks.push({ op, expected, value: missing ? undefined : value, ok: test(op, value, expected, missing) });
  }
  if (checks.length === 0) throw new ConditionError(`${path} 一个比较器都没给`, { path });
  return { path, value: missing ? undefined : value, ok: checks.every((one) => one.ok), missing, checks };
}

// when 里的多个路径之间也是"且"。when 不给就是不设条件。
export function evaluateConditions(when, scope) {
  if (when === undefined || when === null) return { ok: true, checks: [] };
  if (typeof when !== 'object' || Array.isArray(when)) {
    throw new ConditionError('when 要写成对象', {});
  }
  const checks = Object.entries(when)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, spec]) => evaluateCondition(path, spec, scope));
  return { ok: checks.every((one) => one.ok), checks };
}

// 属性缺失的时候，除了 exists，其它比较器一律算不成立。
function test(op, value, expected, missing) {
  if (op === 'exists') return expected ? !missing : missing;
  if (missing) return false;
  switch (op) {
    case 'eq':
      return value === expected;
    case 'ne':
      return value !== expected;
    case 'in':
      return expected.includes(value);
    case 'gt':
      return typeof value === 'number' && value > expected;
    case 'gte':
      return typeof value === 'number' && value >= expected;
    case 'lt':
      return typeof value === 'number' && value < expected;
    case 'lte':
      return typeof value === 'number' && value <= expected;
    case 'has':
      return Array.isArray(value) && value.includes(expected);
    case 'notHas':
      return Array.isArray(value) && !value.includes(expected);
    default:
      return false;
  }
}

function checkExpected(op, expected, path) {
  if (op === 'exists' && typeof expected !== 'boolean') {
    throw new ConditionError(`${path} 的 exists 只接 true / false`, { path, op });
  }
  if (op === 'in' && !Array.isArray(expected)) {
    throw new ConditionError(`${path} 的 in 要接一个数组`, { path, op });
  }
  if (['gt', 'gte', 'lt', 'lte'].includes(op) && typeof expected !== 'number') {
    throw new ConditionError(`${path} 的 ${op} 要接数字`, { path, op });
  }
}
