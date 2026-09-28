// 折行与截断：码点宽度、字素簇断点与禁则修正。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/width.test.js、test/wrap.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

export const DEFAULTS = {
  width: 20,
  breakLongWords: false,
};

const NOT_IMPLEMENTED = 'lib/wrapfold.js 还没实现，口径见 README 的《口径》和《API》';

export function displayWidth(text) {
  void text;
  throw new Error(NOT_IMPLEMENTED);
}

export function wrap(text, options = {}) {
  void text;
  void options;
  throw new Error(NOT_IMPLEMENTED);
}

export function clip(text, width, ellipsis = '…') {
  void text;
  void width;
  void ellipsis;
  throw new Error(NOT_IMPLEMENTED);
}
