// 压缩前缀树：按前缀取 top-k、按编辑距离模糊找、删除后回收结构。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/trie.test.js、test/edge.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》 两节
// 写好了。那些约定不要改，把这里补出来。

const NOT_IMPLEMENTED = 'lib/typemap.js 还没实现，口径见 README 的《口径》和《API》';

export function createIndex(entries = []) {
  void entries;
  throw new Error(NOT_IMPLEMENTED);
}
