// 请求签名：规范请求、派生签名密钥与预签名 URL。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/canonical.test.js、test/sign.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const ALGORITHM = 'AWS4-HMAC-SHA256';

export const DEFAULTS = {
  maxExpires: 604800,
  unsigned: ['authorization', 'user-agent'],
};

const NOT_IMPLEMENTED = 'lib/reqsign.js 还没实现，口径见 README 的《口径》和《API》';

export function canonicalRequest(request) {
  void request;
  throw new Error(NOT_IMPLEMENTED);
}

export function sign(request) {
  void request;
  throw new Error(NOT_IMPLEMENTED);
}

export function presign(request) {
  void request;
  throw new Error(NOT_IMPLEMENTED);
}
