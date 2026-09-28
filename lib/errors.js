// 求解器对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_INPUT',
  'ERR_BAD_RANGE',
  'ERR_UNKNOWN_PACKAGE',
  'ERR_NO_SUCH_VERSION',
  'ERR_UNSATISFIED',
  'ERR_PIN_CONFLICT',
  'ERR_TOO_MANY_BACKTRACKS',
];

export class SolveError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SolveError';
    this.code = code;
    this.details = details;
  }
}
