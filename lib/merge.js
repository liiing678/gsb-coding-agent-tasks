// 行级三方合并。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/basic|conflict|policy）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）和切行工具（lib/lines.js）
// 都已经按 README 的《口径》和《API》两节写好了。那些约定不要改，把这里补出来。

export const DEFAULTS = {
  conflictStyle: 'markers', // markers | ours | theirs | union
  markerLayout: 'diff3',    // diff3 | merge
  oursLabel: 'ours',
  baseLabel: 'base',
  theirsLabel: 'theirs',
};

// 单边行数上限。
export const MAX_LINES = 20000;

const NOT_IMPLEMENTED = 'lib/merge.js 还没实现，口径见 README 的《口径》和《API》';

export function mergeThreeWay(base, ours, theirs, options = {}) {
  void base;
  void ours;
  void theirs;
  void options;
  throw new Error(NOT_IMPLEMENTED);
}
