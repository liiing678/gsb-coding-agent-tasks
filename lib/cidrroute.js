// CIDR 前缀表内核：地址/前缀解析、最长前缀匹配、按值聚合。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/prefix.test.js、test/table.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

const NOT_IMPLEMENTED = 'lib/cidrroute.js 还没实现，口径见 README 的《口径》和《API》';

export function parseAddress(text) {
  void text;
  throw new Error(NOT_IMPLEMENTED);
}

export function parsePrefix(text) {
  void text;
  throw new Error(NOT_IMPLEMENTED);
}

export function formatAddress(family, value) {
  void family;
  void value;
  throw new Error(NOT_IMPLEMENTED);
}

export function createTable() {
  throw new Error(NOT_IMPLEMENTED);
}
