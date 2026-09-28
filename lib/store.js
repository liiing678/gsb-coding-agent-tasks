// 带预写日志的本地 KV。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/txn|recovery|snapshot）、演示脚本
// （scripts/demo.mjs）、帧编解码（lib/codec.js）、追加日志（lib/log.js）和错误码
// （lib/errors.js）都已经按 README 的《口径》和《API》两节写好了。
// 那些约定不要改，把这里补出来。

export const DEFAULTS = {
  maxValueBytes: 262144, // 单个 value 的 UTF-8 字节上限
};

const NOT_IMPLEMENTED = 'lib/store.js 还没实现，口径见 README 的《口径》和《API》';

export function createStore(options = {}) {
  throw new Error(NOT_IMPLEMENTED);
}
