// 时序压缩内核：把 [{ t, v }] 编成字节、再解回来。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/format.test.js、test/roundtrip.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

const NOT_IMPLEMENTED = 'lib/tscodec.js 还没实现，口径见 README 的《口径》和《API》';

export function encodeSeries(points, options) {
  void points;
  void options;
  throw new Error(NOT_IMPLEMENTED);
}

export function decodeSeries(bytes) {
  void bytes;
  throw new Error(NOT_IMPLEMENTED);
}

export function stats(bytes) {
  void bytes;
  throw new Error(NOT_IMPLEMENTED);
}
