// Merkle 日志内核：叶子/节点哈希、根、包含证明与一致性证明。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/merkle.test.js、test/verify.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import { createHash } from 'node:crypto';

import { MerkleError } from './errors.js';

const HASH_RE = /^[0-9a-f]{64}$/;

// 空树的根 = SHA256()（零字节输入）。
const EMPTY_ROOT = createHash('sha256').digest('hex');

const fail = (code, message) => {
  throw new MerkleError(code, message);
};

const isHash = (value) => typeof value === 'string' && HASH_RE.test(value);

const isNonNegInt = (value) => Number.isSafeInteger(value) && value >= 0;

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const digest = (chunks) => {
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
};

// SHA256(0x01 || bytes(left) || bytes(right))，入参是小写 hex。
const combine = (left, right) => digest([
  Buffer.from([0x01]),
  Buffer.from(left, 'hex'),
  Buffer.from(right, 'hex'),
]);

// 严格小于 n 的最大的 2 的幂（n >= 2）：n=2 → 1，n=4 → 2，n=5 → 4。
const splitPoint = (n) => {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
};

export function leafHash(data) {
  if (typeof data !== 'string') {
    fail('ERR_BAD_ARGUMENT', 'leafHash(data): data 必须是字符串');
  }
  return digest([Buffer.from([0x00]), Buffer.from(data, 'utf8')]);
}

export function nodeHash(left, right) {
  if (!isHash(left) || !isHash(right)) {
    fail('ERR_BAD_ARGUMENT', 'nodeHash(left, right): 两个参数都必须是 64 位小写十六进制哈希');
  }
  return combine(left, right);
}

// MTH(D[lo : lo+n])。
const mth = (leaves, lo, n) => {
  if (n === 0) return EMPTY_ROOT;
  if (n === 1) return leaves[lo];
  const k = splitPoint(n);
  return combine(mth(leaves, lo, k), mth(leaves, lo + k, n - k));
};

// path(m, lo, n)：先走目标所在的半边，再把另一边的 MTH 按顺序塞进 path。
const buildInclusion = (leaves, lo, n, target, path) => {
  if (n === 1) return;
  const k = splitPoint(n);
  if (target - lo < k) {
    buildInclusion(leaves, lo, k, target, path);
    path.push(mth(leaves, lo + k, n - k));
  } else {
    buildInclusion(leaves, lo + k, n - k, target, path);
    path.push(mth(leaves, lo, k));
  }
};

// sub(m, lo, n, whole)：whole 只在「整棵子树都属于老树」时为 true，
// 走右半边（m > k）递归时强制转成 false。
const buildConsistency = (leaves, m, lo, n, whole, path) => {
  if (n === m) {
    if (!whole) path.push(mth(leaves, lo, n));
    return;
  }
  const k = splitPoint(n);
  if (m <= k) {
    buildConsistency(leaves, m, lo, k, whole, path);
    path.push(mth(leaves, lo + k, n - k));
  } else {
    buildConsistency(leaves, m - k, lo + k, n - k, false, path);
    path.push(mth(leaves, lo, k));
  }
}

export function createLog() {
  const leaves = [];

  const append = (data) => {
    if (typeof data !== 'string') {
      fail('ERR_BAD_ARGUMENT', 'append(data): data 必须是字符串');
    }
    const index = leaves.length;
    const hash = leafHash(data);
    leaves.push(hash);
    return { index, hash };
  };

  const appendAll = (list) => {
    if (!Array.isArray(list)) {
      fail('ERR_BAD_ARGUMENT', 'appendAll(list): list 必须是数组');
    }
    return list.map((data) => append(data));
  };

  const size = () => leaves.length;

  const leafAt = (index) => {
    if (!isNonNegInt(index)) {
      fail('ERR_BAD_ARGUMENT', 'leafAt(index): index 必须是非负整数');
    }
    if (index >= leaves.length) {
      fail('ERR_OUT_OF_RANGE', `leafAt(index): index ${index} 超出 [0, ${leaves.length})`);
    }
    return leaves[index];
  };

  const root = () => mth(leaves, 0, leaves.length);

  const inclusionProof = (index) => {
    if (!isNonNegInt(index)) {
      fail('ERR_BAD_ARGUMENT', 'inclusionProof(index): index 必须是非负整数');
    }
    if (index >= leaves.length) {
      fail('ERR_OUT_OF_RANGE', `inclusionProof(index): index ${index} 超出 [0, ${leaves.length})`);
    }
    const path = [];
    buildInclusion(leaves, 0, leaves.length, index, path);
    return { index, size: leaves.length, path };
  };

  const consistencyProof = (fromSize) => {
    if (!isNonNegInt(fromSize)) {
      fail('ERR_BAD_ARGUMENT', 'consistencyProof(fromSize): fromSize 必须是非负整数');
    }
    if (fromSize > leaves.length) {
      fail('ERR_OUT_OF_RANGE', `consistencyProof(fromSize): ${fromSize} > ${leaves.length}`);
    }
    // m === 0 和 m === n 都是空数组，不塞任何哈希（包括根）。
    if (fromSize === 0 || fromSize === leaves.length) return [];
    const path = [];
    buildConsistency(leaves, fromSize, 0, leaves.length, true, path);
    return path;
  };

  return {
    append,
    appendAll,
    size,
    leafAt,
    root,
    inclusionProof,
    consistencyProof,
  };
}

export function verifyInclusion(proof) {
  if (!isPlainObject(proof)) {
    fail('ERR_BAD_ARGUMENT', 'verifyInclusion(proof): 参数必须是对象');
  }
  const { leaf, index, size, path, root } = proof;
  if (
    !isHash(leaf) ||
    !isNonNegInt(index) ||
    !isNonNegInt(size) ||
    !Array.isArray(path) ||
    !path.every(isHash) ||
    !isHash(root)
  ) {
    fail('ERR_BAD_ARGUMENT', 'verifyInclusion(proof): 字段形状不符合要求');
  }
  if (size === 0 || index >= size) return false;

  // 按生成时同样的递归顺序用游标取哈希，从叶子往上拼根。
  let cursor = 0;
  const rebuild = (lo, n) => {
    if (n === 1) return leaf;
    const k = splitPoint(n);
    if (index - lo < k) {
      const left = rebuild(lo, k);
      const right = path[cursor];
      cursor += 1;
      return combine(left, right);
    }
    const right = rebuild(lo + k, n - k);
    const left = path[cursor];
    cursor += 1;
    return combine(left, right);
  };

  let computed;
  try {
    computed = rebuild(0, size);
  } catch {
    return false; // 证明不够取（少一个）等取值失败，一律是值对不上。
  }
  return cursor === path.length && computed === root;
}

export function verifyConsistency(proof) {
  if (!isPlainObject(proof)) {
    fail('ERR_BAD_ARGUMENT', 'verifyConsistency(proof): 参数必须是对象');
  }
  const { fromSize, fromRoot, toSize, toRoot, path } = proof;
  if (
    !isNonNegInt(fromSize) ||
    !isNonNegInt(toSize) ||
    !isHash(fromRoot) ||
    !isHash(toRoot) ||
    !Array.isArray(path) ||
    !path.every(isHash)
  ) {
    fail('ERR_BAD_ARGUMENT', 'verifyConsistency(proof): 字段形状不符合要求');
  }
  if (fromSize > toSize) return false;
  if (fromSize === toSize) return path.length === 0 && fromRoot === toRoot;
  if (fromSize === 0) return path.length === 0 && fromRoot === EMPTY_ROOT;

  // 与生成同序地消费 path，同时重建老树前缀根和新树根：
  // 返回 [该子树范围内老树部分的 MTH, 整棵子树在新树里的 MTH]。
  let cursor = 0;
  const rebuild = (lo, n, m, whole) => {
    if (n === m) {
      if (whole) return [fromRoot, fromRoot];
      const hash = path[cursor];
      cursor += 1;
      return [hash, hash];
    }
    const k = splitPoint(n);
    if (m <= k) {
      const [oldLeft, newLeft] = rebuild(lo, k, m, whole);
      const right = path[cursor];
      cursor += 1;
      return [oldLeft, combine(newLeft, right)];
    }
    const [oldRight, newRight] = rebuild(lo + k, n - k, m - k, false);
    const left = path[cursor];
    cursor += 1;
    return [combine(left, oldRight), combine(left, newRight)];
  };

  let oldHash;
  let newHash;
  try {
    [oldHash, newHash] = rebuild(0, toSize, fromSize, true);
  } catch {
    return false;
  }
  return cursor === path.length && oldHash === fromRoot && newHash === toRoot;
}
