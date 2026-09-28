// Merkle 日志内核：叶子/节点哈希、根、包含证明与一致性证明。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/merkle.test.js、test/verify.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

const NOT_IMPLEMENTED = 'lib/merkletree.js 还没实现，口径见 README 的《口径》和《API》';

export function leafHash(data) {
  void data;
  throw new Error(NOT_IMPLEMENTED);
}

export function nodeHash(left, right) {
  void left;
  void right;
  throw new Error(NOT_IMPLEMENTED);
}

export function createLog() {
  throw new Error(NOT_IMPLEMENTED);
}

export function verifyInclusion(proof) {
  void proof;
  throw new Error(NOT_IMPLEMENTED);
}

export function verifyConsistency(proof) {
  void proof;
  throw new Error(NOT_IMPLEMENTED);
}
