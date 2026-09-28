// 分片上传的会话引擎。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/session|store|restore）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）、哈希（lib/hash.js）
// 和字节仓库（lib/blobstore.js）都已经按 README 的《口径》和《API》两节写好了。
// 那些约定不要改，把这里补出来。

export const DEFAULTS = {
  maxStoreBytes: 64 * 1024 * 1024, // 所有 blob 相加的存储上限
  ttlMs: 60 * 60 * 1000,           // open 的会话多久没人动就过期
  completedTtlMs: 5 * 60 * 1000,   // complete 的会话保留多久
};

const NOT_IMPLEMENTED = 'lib/relay.js 还没实现，口径见 README 的《口径》和《API》';

export class UploadRelay {
  constructor(options = {}) {
    this.options = options;
    throw new Error(NOT_IMPLEMENTED);
  }

  create(input) {
    throw new Error(NOT_IMPLEMENTED);
  }

  putChunk(id, index, bytes, hash) {
    throw new Error(NOT_IMPLEMENTED);
  }

  status(id) {
    throw new Error(NOT_IMPLEMENTED);
  }

  complete(id) {
    throw new Error(NOT_IMPLEMENTED);
  }

  abort(id) {
    throw new Error(NOT_IMPLEMENTED);
  }

  sweep() {
    throw new Error(NOT_IMPLEMENTED);
  }

  stats() {
    throw new Error(NOT_IMPLEMENTED);
  }

  snapshot() {
    throw new Error(NOT_IMPLEMENTED);
  }

  restore(snapshot) {
    throw new Error(NOT_IMPLEMENTED);
  }

  onEvent(fn) {
    throw new Error(NOT_IMPLEMENTED);
  }
}
