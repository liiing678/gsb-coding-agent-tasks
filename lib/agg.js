// 聚合本身：一个窗口一个 key 的聚合状态怎么长、吃一个值怎么变、输出成什么样。
// 窗口怎么切、水位怎么走、谁算迟到，都不在这个文件里。

export const KINDS = ['count', 'sum', 'min', 'max', 'avg'];

const SPEC_RE = /^(count|sum|min|max|avg)(?::([A-Za-z_][A-Za-z0-9_]*))?$/;

// 'count' -> { kind: 'count', field: null }；'sum:bytes' -> { kind: 'sum', field: 'bytes' }
// 认不出来就给 null。
export function parseSpec(spec) {
  if (typeof spec !== 'string') return null;
  const matched = SPEC_RE.exec(spec);
  if (!matched) return null;
  const kind = matched[1];
  const field = matched[2] ?? null;
  if (kind === 'count' ? field !== null : field === null) return null;
  return { kind, field };
}

// 这个聚合需要事件里带哪个字段（count 谁都不需要）。
export function fieldsOf(parsed) {
  return parsed.field === null ? [] : [parsed.field];
}

export function emptyAggregate(parsed) {
  return { kind: parsed.kind, field: parsed.field, count: 0, sum: 0, min: null, max: null };
}

export function addValue(state, value) {
  const next = { ...state, count: state.count + 1 };
  if (state.kind === 'count') return next;
  next.sum = state.sum + value;
  next.min = state.min === null ? value : Math.min(state.min, value);
  next.max = state.max === null ? value : Math.max(state.max, value);
  return next;
}

export function renderAggregate(state) {
  switch (state.kind) {
    case 'count':
      return state.count;
    case 'sum':
      return round6(state.sum);
    case 'min':
      return state.min;
    case 'max':
      return state.max;
    case 'avg':
      return state.count === 0 ? null : round6(state.sum / state.count);
    default:
      return null;
  }
}

// 小数加着加着会带出 0.30000000000000004 这种尾巴，统一按 6 位小数收一下。
export function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}
