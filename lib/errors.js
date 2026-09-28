// 忽略规则对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_ARGS',
  'ERR_BAD_RULE',
  'ERR_BAD_PATH',
];

export class IgnoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'IgnoreError';
    this.code = code;
    this.details = details;
  }
}
