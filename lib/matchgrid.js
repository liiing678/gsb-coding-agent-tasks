// 多模式匹配（Aho–Corasick）与流式扫描。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/scan.test.js、test/stream.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

const NOT_IMPLEMENTED = 'lib/matchgrid.js 还没实现，口径见 README 的《口径》和《API》';

export function createMatcher(patterns, options = {}) {
  void patterns;
  void options;
  throw new Error(NOT_IMPLEMENTED);
}

export function scan(patterns, text, options = {}) {
  void patterns;
  void text;
  void options;
  throw new Error(NOT_IMPLEMENTED);
}

export function createScanner(patterns, options = {}) {
  void patterns;
  void options;
  throw new Error(NOT_IMPLEMENTED);
}
