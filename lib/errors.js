// 折行这边对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_ARGS',
];

export class WrapfoldError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WrapfoldError';
    this.code = code;
    this.details = details;
  }
}
