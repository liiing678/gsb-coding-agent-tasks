// 内容定义分块的去重存储。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/chunk.test.js、test/refs.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

export const DEFAULTS = {
  minBytes: 64,
  maxBytes: 256,
  windowBytes: 16,
  boundaryBits: 6,
};

const NOT_IMPLEMENTED = 'lib/dedupstore.js 还没实现，口径见 README 的《口径》和《API》';

export function createDedupStore(config = {}) {
  void config;
  throw new Error(NOT_IMPLEMENTED);
}
