// 重复日程展开。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/rules|dst|overrides）、演示脚本
// （scripts/demo.mjs）、规则解析（lib/ics.js）、时区换算（lib/tz.js）和错误码
// （lib/errors.js）都已经按 README 的《口径》和《API》两节写好了。
// 那些约定不要改，把这里补出来。

export const DEFAULTS = {
  limit: 1000,          // 结果条数上限
  maxIterations: 100000, // 内部周期数上限
};

const NOT_IMPLEMENTED = 'lib/expand.js 还没实现，口径见 README 的《口径》和《API》';

export function expandSeries(series = {}, options = {}) {
  throw new Error(NOT_IMPLEMENTED);
}
