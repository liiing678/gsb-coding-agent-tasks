// 依赖版本求解。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/solve|conflict|pins）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）、版本范围（lib/semver.js）
// 和包源（lib/registry.js）都已经按 README 的《口径》和《API》两节写好了。
// 那些约定不要改，把这里补出来。

export const DEFAULTS = {
  maxBacktracks: 200, // 回退次数上限，超了报 ERR_TOO_MANY_BACKTRACKS
};

const NOT_IMPLEMENTED = 'lib/resolve.js 还没实现，口径见 README 的《口径》和《API》';

export function resolveDeps(input = {}) {
  void input;
  throw new Error(NOT_IMPLEMENTED);
}
