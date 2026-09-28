// 事件时间窗口聚合。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/emit|late|state）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）和聚合算法（lib/agg.js）
// 都已经按 README 的《口径》和《API》两节写好了。那些约定不要改，把这里补出来。

export const DEFAULTS = {
  windowMs: 1000,          // 窗口宽度（必须 > 0）
  watermarkDelayMs: 0,     // 水位 = 见过最大的事件时间 - 这个值
  allowedLatenessMs: 0,    // 窗口到点之后再宽限多久才关
  retentionMs: 60000,      // 关掉的窗口还留多久
  aggregations: ['count'],
};

const NOT_IMPLEMENTED = 'lib/stream.js 还没实现，口径见 README 的《口径》和《API》';

export function createAggregator(config = {}) {
  void config;
  throw new Error(NOT_IMPLEMENTED);
}
