// 定时任务编排。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/cron.test.js、test/schedule.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

export const MINUTE = 60000;

export const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'weekday', min: 0, max: 7 },
];

export const DEFAULTS = {
  retries: 0,
  backoffMs: 1000,
};

const NOT_IMPLEMENTED = 'lib/scheduler.js 还没实现，口径见 README 的《口径》和《API》';

export function parseCron(expression) {
  void expression;
  throw new Error(NOT_IMPLEMENTED);
}

export function slot(at) {
  void at;
  throw new Error(NOT_IMPLEMENTED);
}

export function createScheduler(config = {}) {
  void config;
  throw new Error(NOT_IMPLEMENTED);
}
