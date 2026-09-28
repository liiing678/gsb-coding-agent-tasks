// 多租户限流与配额。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/bucket|window|gate）、演示脚本
// （scripts/demo.mjs）、时钟（lib/clock.js）和错误码（lib/errors.js）都已经按
// README 的《口径》和《API》两节写好了。那些约定不要改，把这里补出来。

export const DEFAULTS = {
  windowMs: 1000, // window.sizeMs 不给的时候用这个
};

const NOT_IMPLEMENTED = 'lib/gate.js 还没实现，口径见 README 的《口径》和《API》';

export function createGate(options = {}) {
  throw new Error(NOT_IMPLEMENTED);
}
