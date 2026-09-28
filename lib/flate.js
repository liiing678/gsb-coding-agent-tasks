// DEFLATE 解压内核：stored / 固定霍夫曼 / 动态霍夫曼三种块，外加 zlib 包装与 Adler-32 校验。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/inflate.test.js、test/zlib.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

const NOT_IMPLEMENTED = 'lib/flate.js 还没实现，口径见 README 的《口径》和《API》';

export function inflateRaw(input) {
  void input;
  throw new Error(NOT_IMPLEMENTED);
}

export function inflateZlib(input) {
  void input;
  throw new Error(NOT_IMPLEMENTED);
}

export function adler32(input, seed = 1) {
  void input;
  void seed;
  throw new Error(NOT_IMPLEMENTED);
}