// piece table 文本缓冲内核：编辑、分行定位、撤销重做与事务。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/buffer.test.js、test/lines.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

const NOT_IMPLEMENTED = 'lib/pagetable.js 还没实现，口径见 README 的《口径》和《API》';

export function createBuffer(text) {
  void text;
  throw new Error(NOT_IMPLEMENTED);
}
