// 两阶段提交协调器。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/decide.test.js、test/recover.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

export const DEFAULTS = {
  prepareTimeoutMs: 30000,
  retryBackoffMs: 1000,
};

export const MESSAGE_TYPES = ['prepare', 'commit', 'abort'];
export const REPLY_TYPES = ['vote', 'ack'];

const NOT_IMPLEMENTED = 'lib/coordinator.js 还没实现，口径见 README 的《口径》和《API》';

export function createCoordinator(config = {}) {
  void config;
  throw new Error(NOT_IMPLEMENTED);
}
