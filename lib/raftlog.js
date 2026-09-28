// Raft 日志复制内核：任期、冲突截断、提交规则、快照与成员变更。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/log.test.js、test/cluster.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。选举和投票不在这题的范围内。

const NOT_IMPLEMENTED = 'lib/raftlog.js 还没实现，口径见 README 的《口径》和《API》';

export function createNode(config = {}) {
  void config;
  throw new Error(NOT_IMPLEMENTED);
}
