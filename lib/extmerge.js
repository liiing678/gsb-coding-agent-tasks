// 有界内存的外部归并排序。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/sort.test.js、test/bash.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

export const DEFAULTS = {
  maxInMemory: 16,
  fanIn: 4,
};

const NOT_IMPLEMENTED = 'lib/extmerge.js 还没实现，口径见 README 的《口径》和《API》';

export function createSorter(config = {}) {
  void config;
  throw new Error(NOT_IMPLEMENTED);
}
