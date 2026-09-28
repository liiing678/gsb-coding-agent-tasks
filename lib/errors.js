// 缓存层对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_CONFIG',
  'ERR_BAD_REQUEST',
  'ERR_BAD_RESPONSE',
  'ERR_BAD_ARGS',
];

export class HttpCacheError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HttpCacheError';
    this.code = code;
    this.details = details;
  }
}
