// 表达式编译器与栈式虚拟机：把源码编成指令，再拿环境跑出结果。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/compile.test.js、test/edge.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》《指令集》《API》 三节
// 写好了。那些约定不要改，把这里补出来。

const NOT_IMPLEMENTED = 'lib/exprvm.js 还没实现，口径见 README 的《口径》和《API》';

export function compile(source, options = {}) {
  void source;
  void options;
  throw new Error(NOT_IMPLEMENTED);
}
