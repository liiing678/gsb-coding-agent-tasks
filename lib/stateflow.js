// 层级状态机（SCXML 子集）的解释器。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/machine.test.js、test/history.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

export const DEFAULTS = {
  maxSteps: 100,
};

const NOT_IMPLEMENTED = 'lib/stateflow.js 还没实现，口径见 README 的《口径》和《API》';

export function createMachine(definition, options = {}) {
  void definition;
  void options;
  throw new Error(NOT_IMPLEMENTED);
}

export function run(definition, events, options = {}) {
  void definition;
  void events;
  void options;
  throw new Error(NOT_IMPLEMENTED);
}
