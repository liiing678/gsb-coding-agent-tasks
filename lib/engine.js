// 内存查询引擎。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/query.test.js、test/agg.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

export const DEFAULTS = {
  limit: null,
  offset: 0,
};

export const CONDITION_OPS = ['=', '!=', '<', '<=', '>', '>=', 'in', 'is-null', 'not-null'];
export const AGGREGATES = ['count', 'sum', 'avg', 'min', 'max'];
export const JOIN_TYPES = ['inner', 'left'];

const NOT_IMPLEMENTED = 'lib/engine.js 还没实现，口径见 README 的《口径》和《API》';

export function createEngine(config = {}) {
  void config;
  throw new Error(NOT_IMPLEMENTED);
}
