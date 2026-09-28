// 这套实现对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_ARGUMENT',
  'ERR_BAD_SYNTAX',
  'ERR_UNKNOWN_NAME',
  'ERR_TYPE',
  'ERR_DIVIDE_BY_ZERO',
];

export class ExprError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ExprError';
    this.code = code;
    this.details = details;
  }
}
