// 合并引擎对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_INPUT',
  'ERR_BAD_OPTION',
  'ERR_TOO_MANY_LINES',
];

export class MergeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MergeError';
    this.code = code;
    this.details = details;
  }
}
