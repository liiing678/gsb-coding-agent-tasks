// 补全索引这边对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_ARGUMENT',
  'ERR_BUDGET_EXCEEDED',
];

export class IndexError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'IndexError';
    this.code = code;
    this.details = details;
  }
}
