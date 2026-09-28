// JSON 指针、patch、merge patch、diff 与反向 patch，口径见 README 的《口径》和《API》。

import { JsonpatchError } from './errors.js';

const fail = (code, message) => {
  throw new JsonpatchError(code, message);
};

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clone = (value) => structuredClone(value);

// 合法数组下标：'0' 或者不以 0 开头的十进制。
const INDEX_RE = /^(?:0|[1-9][0-9]*)$/;
const arrayIndex = (token) => (INDEX_RE.test(token) ? Number(token) : null);

export function parsePointer(text) {
  if (typeof text !== 'string') fail('ERR_BAD_POINTER', '指针必须是字符串');
  if (text === '') return [];
  if (text[0] !== '/') fail('ERR_BAD_POINTER', '指针必须以 / 开头');

  const tokens = [];
  const segments = text.split('/');
  for (let s = 1; s < segments.length; s += 1) {
    const segment = segments[s];
    let decoded = '';
    // 从左往右一个字符一个字符地看：~01 -> ~1，而不是别的东西。
    for (let i = 0; i < segment.length; i += 1) {
      const ch = segment[i];
      if (ch === '~') {
        const next = segment[i + 1];
        if (next === '0') decoded += '~';
        else if (next === '1') decoded += '/';
        else fail('ERR_BAD_POINTER', '~ 后面只能是 0 或 1');
        i += 1;
      } else {
        decoded += ch;
      }
    }
    tokens.push(decoded);
  }
  return tokens;
}

export function formatPointer(tokens) {
  if (!Array.isArray(tokens)) fail('ERR_BAD_POINTER', 'tokens 必须是数组');
  const escaped = tokens.map((token) => {
    let segment = token;
    if (typeof segment === 'number') {
      if (!Number.isInteger(segment) || segment < 0) {
        fail('ERR_BAD_POINTER', '数字段只能是非负整数');
      }
      segment = String(segment);
    } else if (typeof segment !== 'string') {
      fail('ERR_BAD_POINTER', '每段只能是字符串或非负整数');
    }
    // 先转义 ~ 再转义 /，顺序反了会把 ~0 自己再弄坏。
    return segment.replace(/~/g, '~0').replace(/\//g, '~1');
  });
  return escaped.length === 0 ? '' : `/${escaped.join('/')}`;
}

// 在容器上走一步；数组下标写歪了是 BAD_POINTER，其余取不到都是 PATH_MISSING。
const step = (current, token) => {
  if (Array.isArray(current)) {
    if (token === '-') fail('ERR_PATH_MISSING', '- 不指向实际元素');
    const index = arrayIndex(token);
    if (index === null) fail('ERR_BAD_POINTER', `不是合法数组下标：${token}`);
    if (index >= current.length) fail('ERR_PATH_MISSING', '数组下标越界');
    return current[index];
  }
  if (isPlainObject(current)) {
    if (!Object.hasOwn(current, token)) fail('ERR_PATH_MISSING', `键不存在：${token}`);
    return current[token];
  }
  fail('ERR_PATH_MISSING', '当前值不是对象或数组');
};

const navigate = (root, tokens) => {
  let current = root;
  for (const token of tokens) current = step(current, token);
  return current;
};

export function get(doc, pointer) {
  return navigate(doc, parsePointer(pointer));
}

export function equals(left, right) {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null ||
      typeof right !== 'object' || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => equals(item, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(right, key) && equals(left[key], right[key]),
  );
}

// 解析 add 目标：定位父节点并把最后一段解释成数组下标或对象键。
const resolveAddTarget = (root, tokens) => {
  if (tokens.length === 0) return { kind: 'root' };
  const parent = navigate(root, tokens.slice(0, -1));
  const last = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    let index;
    if (last === '-') {
      index = parent.length;
    } else {
      const parsed = arrayIndex(last);
      if (parsed === null) fail('ERR_BAD_POINTER', `不是合法数组下标：${last}`);
      index = parsed;
    }
    // 等于长度算追加，比长度大才算越界。
    if (index > parent.length) fail('ERR_PATH_MISSING', 'add 下标越过数组末尾');
    return { kind: 'array', parent, index };
  }
  if (isPlainObject(parent)) return { kind: 'object', parent, key: last };
  fail('ERR_PATH_MISSING', 'add 的父节点不是对象或数组');
};

const addAt = (root, tokens, value) => {
  const target = resolveAddTarget(root, tokens);
  if (target.kind === 'root') return clone(value);
  if (target.kind === 'array') {
    target.parent.splice(target.index, 0, clone(value));
  } else {
    target.parent[target.key] = clone(value);
  }
  return root;
};

const removeAt = (root, tokens) => {
  if (tokens.length === 0) fail('ERR_BAD_PATCH', '空指针上不能 remove');
  const parent = navigate(root, tokens.slice(0, -1));
  const last = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    if (last === '-') fail('ERR_PATH_MISSING', 'remove 不认 -');
    const index = arrayIndex(last);
    if (index === null) fail('ERR_BAD_POINTER', `不是合法数组下标：${last}`);
    if (index >= parent.length) fail('ERR_PATH_MISSING', 'remove 下标越界');
    const [removed] = parent.splice(index, 1);
    return [root, removed];
  }
  if (isPlainObject(parent)) {
    if (!Object.hasOwn(parent, last)) fail('ERR_PATH_MISSING', `键不存在：${last}`);
    const removed = parent[last];
    delete parent[last];
    return [root, removed];
  }
  fail('ERR_PATH_MISSING', 'remove 的父节点不是对象或数组');
};

const replaceAt = (root, tokens, value) => {
  if (tokens.length === 0) return [clone(value), root];
  const parent = navigate(root, tokens.slice(0, -1));
  const last = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    if (last === '-') fail('ERR_PATH_MISSING', 'replace 不认 -');
    const index = arrayIndex(last);
    if (index === null) fail('ERR_BAD_POINTER', `不是合法数组下标：${last}`);
    if (index >= parent.length) fail('ERR_PATH_MISSING', 'replace 下标越界');
    const previous = parent[index];
    parent[index] = clone(value);
    return [root, previous];
  }
  if (isPlainObject(parent)) {
    if (!Object.hasOwn(parent, last)) fail('ERR_PATH_MISSING', `键不存在：${last}`);
    const previous = parent[last];
    parent[last] = clone(value);
    return [root, previous];
  }
  fail('ERR_PATH_MISSING', 'replace 的父节点不是对象或数组');
};

const KNOWN_OPS = new Set(['add', 'remove', 'replace', 'move', 'copy', 'test']);

// 结构检查：op / path / from / value 缺失或类型不对是 BAD_PATCH，指针本身不合法是 BAD_POINTER。
const normalizeOp = (op) => {
  if (!isPlainObject(op)) fail('ERR_BAD_PATCH', '每条操作必须是对象');
  if (!KNOWN_OPS.has(op.op)) fail('ERR_BAD_PATCH', `不认识的 op：${op.op}`);
  if (typeof op.path !== 'string') fail('ERR_BAD_PATCH', 'path 必须是字符串');
  const normalized = {
    name: op.op,
    path: op.path,
    pathTokens: parsePointer(op.path),
  };
  if (normalized.name === 'move' || normalized.name === 'copy') {
    if (typeof op.from !== 'string') fail('ERR_BAD_PATCH', 'from 必须是字符串');
    normalized.from = op.from;
    normalized.fromTokens = parsePointer(op.from);
  }
  if (['add', 'replace', 'test'].includes(normalized.name) && !('value' in op)) {
    fail('ERR_BAD_PATCH', `${normalized.name} 必须带 value`);
  }
  normalized.value = op.value;
  return normalized;
};

const isStrictPrefix = (prefixTokens, tokens) =>
  prefixTokens.length < tokens.length &&
  prefixTokens.every((token, index) => token === tokens[index]);

const sameTokens = (left, right) =>
  left.length === right.length && left.every((token, index) => token === right[index]);

const dispatch = (root, op) => {
  switch (op.name) {
    case 'add':
      return addAt(root, op.pathTokens, op.value);
    case 'remove':
      return removeAt(root, op.pathTokens)[0];
    case 'replace':
      return replaceAt(root, op.pathTokens, op.value)[0];
    case 'move': {
      // move / copy 不碰空指针；from 是 path 的严格前缀等于往自己里面塞。
      if (op.fromTokens.length === 0 || op.pathTokens.length === 0) {
        fail('ERR_BAD_PATCH', 'move 的 from 和 path 都不能为空指针');
      }
      if (isStrictPrefix(op.fromTokens, op.pathTokens)) {
        fail('ERR_BAD_PATCH', '不能 move 进自己的子路径');
      }
      if (sameTokens(op.fromTokens, op.pathTokens)) return root;
      let moved;
      [root, moved] = removeAt(root, op.fromTokens);
      return addAt(root, op.pathTokens, moved);
    }
    case 'copy': {
      if (op.fromTokens.length === 0 || op.pathTokens.length === 0) {
        fail('ERR_BAD_PATCH', 'copy 的 from 和 path 都不能为空指针');
      }
      const source = navigate(root, op.fromTokens);
      return addAt(root, op.pathTokens, clone(source));
    }
    case 'test': {
      const actual = navigate(root, op.pathTokens);
      if (!equals(actual, op.value)) fail('ERR_TEST_FAILED', 'test 没对上');
      return root;
    }
    default:
      return fail('ERR_BAD_PATCH', `不认识的 op：${op.name}`);
  }
};

export function apply(doc, patch) {
  if (!Array.isArray(patch)) fail('ERR_BAD_PATCH', 'patch 必须是数组');
  // 先深拷贝，整条 patch 都改在副本上；中途抛错直接丢掉副本，原文档纹丝不动。
  let root = clone(doc);
  for (let index = 0; index < patch.length; index += 1) {
    try {
      root = dispatch(root, normalizeOp(patch[index]));
    } catch (err) {
      if (err instanceof JsonpatchError) err.details.index = index;
      throw err;
    }
  }
  return root;
}

const diffArray = (left, right, prefix) => {
  const n = left.length;
  const m = right.length;
  // dp[i][j] = left[i..] 与 right[j..] 的最长公共子序列长度。
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = equals(left[i], right[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (equals(left[i], right[j])) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // 并列时算放弃 left[i]，也就是先删。
      removed.push(i);
      i += 1;
    } else {
      added.push(j);
      j += 1;
    }
  }
  while (i < n) {
    removed.push(i);
    i += 1;
  }
  while (j < m) {
    added.push(j);
    j += 1;
  }

  const ops = [];
  const pathAt = (index) => formatPointer([...prefix, String(index)]);
  // 删要从大到小，加要从小到大；add 的下标正好是该元素在 b 里的位置。
  for (let r = removed.length - 1; r >= 0; r -= 1) {
    ops.push({ op: 'remove', path: pathAt(removed[r]) });
  }
  for (let a = 0; a < added.length; a += 1) {
    ops.push({ op: 'add', path: pathAt(added[a]), value: clone(right[added[a]]) });
  }
  return ops;
};

const diffInto = (left, right, prefix, ops) => {
  if (equals(left, right)) return;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      ops.push({ op: 'replace', path: formatPointer(prefix), value: clone(right) });
    } else {
      ops.push(...diffArray(left, right, prefix));
    }
    return;
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    // a 里有、b 里没有的先 remove。
    for (const key of Object.keys(left)) {
      if (!Object.hasOwn(right, key)) {
        ops.push({ op: 'remove', path: formatPointer([...prefix, key]) });
      }
    }
    // 再按 b 的键顺序 add / replace / 递归。
    for (const key of Object.keys(right)) {
      const nextPrefix = [...prefix, key];
      if (!Object.hasOwn(left, key)) {
        ops.push({ op: 'add', path: formatPointer(nextPrefix), value: clone(right[key]) });
      } else if (!equals(left[key], right[key])) {
        diffInto(left[key], right[key], nextPrefix, ops);
      }
    }
    return;
  }

  ops.push({ op: 'replace', path: formatPointer(prefix), value: clone(right) });
};

export function diff(left, right) {
  const ops = [];
  diffInto(left, right, [], ops);
  return ops;
}

export function mergePatch(target, patchDoc) {
  if (!isPlainObject(patchDoc)) {
    // null、数组、基本类型：整份换成 patchDoc 的深拷贝。
    return clone(patchDoc);
  }
  const result = isPlainObject(target) ? clone(target) : {};
  for (const key of Object.keys(patchDoc)) {
    const patchValue = patchDoc[key];
    if (patchValue === null) {
      delete result[key];
    } else if (isPlainObject(patchValue)) {
      // 对应的值不是对象（包括键本来不存在）时，按空对象递归合并下去。
      result[key] = mergePatch(
        Object.hasOwn(result, key) && isPlainObject(result[key]) ? result[key] : {},
        patchValue,
      );
    } else {
      // 数组整体替换，不按下标合并。
      result[key] = clone(patchValue);
    }
  }
  return result;
}

// add / copy 的反向：看那一刻父节点是数组还是对象、对象上原来有没有这个键。
const invertInsertion = (tokens, root) => {
  if (tokens.length === 0) {
    return [{ op: 'replace', path: '', value: clone(root) }];
  }
  const parent = navigate(root, tokens.slice(0, -1));
  const last = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    let index = last === '-' ? parent.length : arrayIndex(last);
    if (index === null || index > parent.length) {
      fail('ERR_BAD_POINTER', `不是合法数组下标：${last}`);
    }
    return [{ op: 'remove', path: formatPointer([...tokens.slice(0, -1), String(index)]) }];
  }
  if (isPlainObject(parent)) {
    if (Object.hasOwn(parent, last)) {
      return [{ op: 'replace', path: formatPointer(tokens), value: clone(parent[last]) }];
    }
    return [{ op: 'remove', path: formatPointer(tokens) }];
  }
  fail('ERR_PATH_MISSING', '反向的父节点不是对象或数组');
};

export function invert(patch, doc) {
  if (!Array.isArray(patch)) fail('ERR_BAD_PATCH', 'patch 必须是数组');
  let root = clone(doc);
  const reversed = [];

  // 拿着 doc 从前往后走，每条的旧值都取「那一刻」的值；反向操作倒序收集。
  for (let index = 0; index < patch.length; index += 1) {
    const op = normalizeOp(patch[index]);
    let inverse;
    switch (op.name) {
      case 'add':
        inverse = invertInsertion(op.pathTokens, root);
        root = addAt(root, op.pathTokens, op.value);
        break;
      case 'remove': {
        let removed;
        [root, removed] = removeAt(root, op.pathTokens);
        inverse = [{ op: 'add', path: op.path, value: clone(removed) }];
        break;
      }
      case 'replace': {
        let previous;
        [root, previous] = replaceAt(root, op.pathTokens, op.value);
        inverse = [{ op: 'replace', path: op.path, value: clone(previous) }];
        break;
      }
      case 'move': {
        if (op.fromTokens.length === 0 || op.pathTokens.length === 0) {
          fail('ERR_BAD_PATCH', 'move 的 from 和 path 都不能为空指针');
        }
        if (isStrictPrefix(op.fromTokens, op.pathTokens)) {
          fail('ERR_BAD_PATCH', '不能 move 进自己的子路径');
        }
        if (!sameTokens(op.fromTokens, op.pathTokens)) {
          let moved;
          [root, moved] = removeAt(root, op.fromTokens);
          root = addAt(root, op.pathTokens, moved);
        }
        inverse = [{ op: 'move', from: op.path, path: op.from }];
        break;
      }
      case 'copy': {
        if (op.fromTokens.length === 0 || op.pathTokens.length === 0) {
          fail('ERR_BAD_PATCH', 'copy 的 from 和 path 都不能为空指针');
        }
        inverse = invertInsertion(op.pathTokens, root);
        root = dispatch(root, op);
        break;
      }
      case 'test':
        root = dispatch(root, op);
        inverse = null;
        break;
      default:
        fail('ERR_BAD_PATCH', `不认识的 op：${op.name}`);
    }
    if (inverse) reversed.push(inverse);
  }

  return reversed.reverse().flat();
}
