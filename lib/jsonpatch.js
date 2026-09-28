// JSON 指针、patch、merge patch、diff 与反向 patch。口径见 README 的《口径》和《API》。

import { JsonpatchError } from './errors.js';

const fail = (code, message, details = {}) => new JsonpatchError(code, message, details);
const badPointer = (message) => fail('ERR_BAD_POINTER', message);
const pathMissing = (message) => fail('ERR_PATH_MISSING', message);
const badPatch = (message) => fail('ERR_BAD_PATCH', message);
const testFailed = (message) => fail('ERR_TEST_FAILED', message);

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const clone = (value) => structuredClone(value);

// --- 指针 -----------------------------------------------------------------

function decodeToken(token) {
  let out = '';
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i];
    if (ch !== '~') {
      out += ch;
      continue;
    }
    const next = token[i + 1];
    if (next === '0' || next === '1') {
      out += next === '0' ? '~' : '/';
      i += 1;
    } else {
      throw badPointer(`指针段里的 ~ 后面只能是 0 或 1：${token}`);
    }
  }
  return out;
}

export function parsePointer(text) {
  if (typeof text !== 'string') {
    throw badPointer('指针必须是字符串');
  }
  if (text === '') {
    return [];
  }
  if (text[0] !== '/') {
    throw badPointer(`指针必须以 / 开头：${text}`);
  }
  return text.split('/').slice(1).map(decodeToken);
}

const encodeToken = (token) => token.replace(/~/g, '~0').replace(/\//g, '~1');

export function formatPointer(tokens) {
  if (!Array.isArray(tokens)) {
    throw badPointer('formatPointer 的参数必须是数组');
  }
  const parts = tokens.map((token) => {
    if (typeof token === 'string') {
      return encodeToken(token);
    }
    if (typeof token === 'number' && Number.isInteger(token) && token >= 0) {
      return String(token);
    }
    throw badPointer('指针段只能是字符串或非负整数');
  });
  return parts.length === 0 ? '' : `/${parts.join('/')}`;
}

// 合法数组下标：'0' 或者不以 0 开头的十进制；'-' 不在此列，单独处理。
const arrayIndex = (token) => {
  if (token === '0' || /^[1-9][0-9]*$/.test(token)) {
    return Number(token);
  }
  return null;
};

// 沿 tokens 往下取；allowDash 为 true 时最后一段允许 '-'（add 专用）。
// 走完全部段时返回 { value }；allowDash 且停在最后一段时返回 { parent, key, index }。
function reach(doc, tokens, allowDash = false) {
  let cur = doc;
  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k];
    const last = k === tokens.length - 1;
    if (Array.isArray(cur)) {
      if (token === '-') {
        if (allowDash && last) {
          return { parent: cur, key: '-', index: cur.length };
        }
        throw pathMissing('指针里的 - 只在 add 的最后一段表示末尾');
      }
      const index = arrayIndex(token);
      if (index === null) {
        throw badPointer(`数组合法下标只能是 0 或不以 0 开头的十进制：${token}`);
      }
      if (last && allowDash) {
        return { parent: cur, key: token, index };
      }
      if (index >= cur.length) {
        throw pathMissing(`数组下标越界：${index}`);
      }
      cur = cur[index];
    } else if (isPlainObject(cur)) {
      if (last && allowDash) {
        return { parent: cur, key: token, index: null };
      }
      if (!Object.hasOwn(cur, token)) {
        throw pathMissing(`对象上没有这个键：${token}`);
      }
      cur = cur[token];
    } else {
      throw pathMissing('不能在非对象/非数组上继续取路径');
    }
  }
  return { value: cur };
}

export function get(doc, pointer) {
  return reach(doc, parsePointer(pointer)).value;
}

// --- 深度相等 --------------------------------------------------------------

export function equals(left, right) {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== 'object' || left === null
      || typeof right !== 'object' || right === null) {
    return false;
  }
  const leftIsArray = Array.isArray(left);
  const rightIsArray = Array.isArray(right);
  if (leftIsArray || rightIsArray) {
    if (!leftIsArray || !rightIsArray || left.length !== right.length) {
      return false;
    }
    for (let i = 0; i < left.length; i += 1) {
      if (!equals(left[i], right[i])) {
        return false;
      }
    }
    return true;
  }
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || !equals(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

// --- apply ----------------------------------------------------------------

const KNOWN_OPS = new Set(['add', 'remove', 'replace', 'move', 'copy', 'test']);

function validate(op) {
  if (!isPlainObject(op) || typeof op.op !== 'string' || !KNOWN_OPS.has(op.op)) {
    throw badPatch('不认识的 op');
  }
  if (typeof op.path !== 'string') {
    throw badPatch(`${op.op} 缺少合法的 path`);
  }
  if ((op.op === 'add' || op.op === 'replace' || op.op === 'test')
      && !Object.hasOwn(op, 'value')) {
    throw badPatch(`${op.op} 缺少 value`);
  }
  if ((op.op === 'move' || op.op === 'copy') && typeof op.from !== 'string') {
    throw badPatch(`${op.op} 缺少合法的 from`);
  }
}

function addAt(cur, tokens, value) {
  if (tokens.length === 0) {
    return value;
  }
  const { parent, key, index } = reach(cur, tokens, true);
  if (Array.isArray(parent)) {
    if (index > parent.length) {
      throw pathMissing(`add 的数组下标越界：${index}`);
    }
    parent.splice(index, 0, value);
  } else if (isPlainObject(parent)) {
    parent[key] = value; // 已有的键位置不动，新键自然追加在最后
  } else {
    throw pathMissing('只能往对象或数组里 add');
  }
  return cur;
}

function removeAt(cur, tokens) {
  if (tokens.length === 0) {
    throw badPatch('空指针上不能 remove');
  }
  const parent = reach(cur, tokens.slice(0, -1)).value;
  const key = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    if (key === '-') {
      throw pathMissing('remove 不能用 - 当下标');
    }
    const index = arrayIndex(key);
    if (index === null) {
      throw badPointer(`数组合法下标只能是 0 或不以 0 开头的十进制：${key}`);
    }
    if (index >= parent.length) {
      throw pathMissing(`remove 的数组下标越界：${index}`);
    }
    const [removed] = parent.splice(index, 1);
    return removed;
  }
  if (isPlainObject(parent)) {
    if (!Object.hasOwn(parent, key)) {
      throw pathMissing(`remove 的键不存在：${key}`);
    }
    const removed = parent[key];
    delete parent[key];
    return removed;
  }
  throw pathMissing('只能在对象或数组上 remove');
}

function replaceAt(cur, tokens, value) {
  if (tokens.length === 0) {
    return { cur: value, old: cur };
  }
  const parent = reach(cur, tokens.slice(0, -1)).value;
  const key = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    if (key === '-') {
      throw pathMissing('replace 不能用 - 当下标');
    }
    const index = arrayIndex(key);
    if (index === null) {
      throw badPointer(`数组合法下标只能是 0 或不以 0 开头的十进制：${key}`);
    }
    if (index >= parent.length) {
      throw pathMissing(`replace 的数组下标越界：${index}`);
    }
    const old = parent[index];
    parent[index] = value;
    return { cur, old };
  }
  if (isPlainObject(parent)) {
    if (!Object.hasOwn(parent, key)) {
      throw pathMissing(`replace 的键不存在：${key}`);
    }
    const old = parent[key];
    parent[key] = value;
    return { cur, old };
  }
  throw pathMissing('只能在对象或数组上 replace');
}

const isStrictPrefix = (prefix, path) =>
  prefix.length < path.length && prefix.every((token, i) => token === path[i]);

const sameTokens = (a, b) =>
  a.length === b.length && a.every((token, i) => token === b[i]);

// 执行一条操作，返回 { cur, inverse }；inverse 供 invert 收集（test / move 自身为 null）。
function execute(cur, op) {
  validate(op);
  const pathTokens = parsePointer(op.path);

  if (op.op === 'add') {
    if (pathTokens.length === 0) {
      const inverse = { op: 'replace', path: '', value: clone(cur) };
      return { cur: clone(op.value), inverse };
    }
    const { parent, key, index } = reach(cur, pathTokens, true);
    const parentPath = formatPointer(pathTokens.slice(0, -1));
    let inverse;
    if (Array.isArray(parent)) {
      if (index > parent.length) {
        throw pathMissing(`add 的数组下标越界：${index}`);
      }
      inverse = { op: 'remove', path: `${parentPath}/${index}` };
      parent.splice(index, 0, clone(op.value));
    } else if (isPlainObject(parent)) {
      inverse = Object.hasOwn(parent, key)
        ? { op: 'replace', path: op.path, value: clone(parent[key]) }
        : { op: 'remove', path: op.path };
      parent[key] = clone(op.value);
    } else {
      throw pathMissing('只能往对象或数组里 add');
    }
    return { cur, inverse };
  }

  if (op.op === 'remove') {
    const removed = removeAt(cur, pathTokens);
    return { cur, inverse: { op: 'add', path: op.path, value: clone(removed) } };
  }

  if (op.op === 'replace') {
    const result = replaceAt(cur, pathTokens, clone(op.value));
    return {
      cur: result.cur,
      inverse: { op: 'replace', path: op.path, value: clone(result.old) },
    };
  }

  if (op.op === 'move') {
    const fromTokens = parsePointer(op.from);
    if (sameTokens(fromTokens, pathTokens)) {
      return { cur, inverse: null };
    }
    if (isStrictPrefix(fromTokens, pathTokens)) {
      throw badPatch('move 的 from 不能是 path 的前缀');
    }
    const removed = removeAt(cur, fromTokens);
    return {
      cur: addAt(cur, pathTokens, removed),
      inverse: { op: 'move', from: op.path, path: op.from },
    };
  }

  if (op.op === 'copy') {
    const fromTokens = parsePointer(op.from);
    if (pathTokens.length === 0) {
      throw badPatch('copy 的 path 不能是空指针');
    }
    const value = clone(reach(cur, fromTokens).value);
    const { parent, key, index } = reach(cur, pathTokens, true);
    const parentPath = formatPointer(pathTokens.slice(0, -1));
    let inverse;
    if (Array.isArray(parent)) {
      if (index > parent.length) {
        throw pathMissing(`copy 的数组下标越界：${index}`);
      }
      inverse = { op: 'remove', path: `${parentPath}/${index}` };
      parent.splice(index, 0, value);
    } else if (isPlainObject(parent)) {
      inverse = Object.hasOwn(parent, key)
        ? { op: 'replace', path: op.path, value: clone(parent[key]) }
        : { op: 'remove', path: op.path };
      parent[key] = value;
    } else {
      throw pathMissing('只能往对象或数组里 copy');
    }
    return { cur, inverse };
  }

  // test
  const actual = reach(cur, pathTokens).value;
  if (!equals(actual, op.value)) {
    throw testFailed(`test 没通过：${op.path}`);
  }
  return { cur, inverse: null };
}

export function apply(doc, patch) {
  if (!Array.isArray(patch)) {
    throw badPatch('patch 必须是操作数组');
  }
  let cur = clone(doc);
  for (let i = 0; i < patch.length; i += 1) {
    try {
      cur = execute(cur, patch[i]).cur;
    } catch (err) {
      if (err instanceof JsonpatchError) {
        throw fail(err.code, err.message, { ...err.details, index: i });
      }
      throw err;
    }
  }
  return cur;
}

// --- diff -----------------------------------------------------------------

const escapeKey = (key) => encodeToken(key);

function diffArray(a, b, prefix, ops) {
  // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度（元素深相等才算相等）。
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = equals(a[i], b[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // 从前往后扫，挑出保留元素；并列时放弃 a[i]（先删）。
  const keepA = new Array(n).fill(false);
  const keepB = new Array(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (equals(a[i], b[j])) {
      keepA[i] = true;
      keepB[j] = true;
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  // a 里没保留的按下标从大到小删。
  for (let k = n - 1; k >= 0; k -= 1) {
    if (!keepA[k]) {
      ops.push({ op: 'remove', path: `${prefix}/${k}` });
    }
  }
  // b 里没保留的按下标从小到大加；删掉 a 的元素后，摆放位置就是 b 里的下标。
  for (let k = 0; k < m; k += 1) {
    if (!keepB[k]) {
      ops.push({ op: 'add', path: `${prefix}/${k}`, value: clone(b[k]) });
    }
  }
}

function diffAt(a, b, prefix, ops) {
  if (equals(a, b)) {
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    diffArray(a, b, prefix, ops);
    return;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    // a 里有、b 里没有的键先删（按 a 的键顺序）。
    for (const key of Object.keys(a)) {
      if (!Object.hasOwn(b, key)) {
        ops.push({ op: 'remove', path: `${prefix}/${escapeKey(key)}` });
      }
    }
    // 然后按 b 的键顺序：新键 add，共有键递归。键序变了不算差异。
    for (const key of Object.keys(b)) {
      const path = `${prefix}/${escapeKey(key)}`;
      if (!Object.hasOwn(a, key)) {
        ops.push({ op: 'add', path, value: clone(b[key]) });
      } else {
        diffAt(a[key], b[key], path, ops);
      }
    }
    return;
  }
  ops.push({ op: 'replace', path: prefix, value: clone(b) });
}

export function diff(left, right) {
  const ops = [];
  diffAt(left, right, '', ops);
  return ops;
}

// --- merge patch -----------------------------------------------------------

export function mergePatch(target, patchDoc) {
  if (!isPlainObject(patchDoc)) {
    return clone(patchDoc);
  }
  const base = isPlainObject(target) ? clone(target) : {};
  for (const key of Object.keys(patchDoc)) {
    const patchValue = patchDoc[key];
    if (patchValue === null) {
      delete base[key];
    } else if (isPlainObject(patchValue)) {
      // target 对应的值不是对象也当空对象，递归合并
      base[key] = mergePatch(base[key], patchValue);
    } else {
      base[key] = clone(patchValue);
    }
  }
  return base;
}

// --- invert ----------------------------------------------------------------

export function invert(patch, doc) {
  if (!Array.isArray(patch)) {
    throw badPatch('patch 必须是操作数组');
  }
  let cur = clone(doc);
  const inverses = [];
  for (let index = 0; index < patch.length; index += 1) {
    try {
      const result = execute(cur, patch[index]);
      cur = result.cur;
      if (result.inverse) {
        inverses.push(result.inverse);
      }
    } catch (err) {
      if (err instanceof JsonpatchError) {
        throw fail(err.code, err.message, { ...err.details, index });
      }
      throw err;
    }
  }
  return inverses.reverse();
}
