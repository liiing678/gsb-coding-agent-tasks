// 复式记账。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/post.test.js、test/report.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];

const NOT_IMPLEMENTED = 'lib/ledger.js 还没实现，口径见 README 的《口径》和《API》';

export function createLedger(config = {}) {
  void config;
  throw new Error(NOT_IMPLEMENTED);
}
