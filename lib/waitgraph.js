// 事务等待图与死锁检测。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/wait.test.js、test/detect.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

export const DEFAULTS = {
  maxWaitMs: 1000,
};

const NOT_IMPLEMENTED = 'lib/waitgraph.js 还没实现，口径见 README 的《口径》和《API》';

export function createDeadlockDetector(config = {}) {
  void config;
  throw new Error(NOT_IMPLEMENTED);
}
