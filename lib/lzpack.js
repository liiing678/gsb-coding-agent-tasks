// LZSS 打包与解包。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/roundtrip.test.js、test/format.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

export const DEFAULTS = {
  window: 4096,
  minMatch: 3,
  maxMatch: 18,
};

const NOT_IMPLEMENTED = 'lib/lzpack.js 还没实现，口径见 README 的《口径》和《API》';

export function checksum(bytes) {
  void bytes;
  throw new Error(NOT_IMPLEMENTED);
}

export function compress(input) {
  void input;
  throw new Error(NOT_IMPLEMENTED);
}

export function decompress(packed) {
  void packed;
  throw new Error(NOT_IMPLEMENTED);
}
