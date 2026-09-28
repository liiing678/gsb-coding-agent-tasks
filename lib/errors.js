// 去重存储对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_CONFIG',
  'ERR_BAD_ARGS',
  'ERR_DUPLICATE_OBJECT',
  'ERR_UNKNOWN_OBJECT',
  'ERR_OBJECT_PINNED',
  'ERR_DUPLICATE_SNAPSHOT',
  'ERR_UNKNOWN_SNAPSHOT',
];

export class DedupError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DedupError';
    this.code = code;
    this.details = details;
  }
}
