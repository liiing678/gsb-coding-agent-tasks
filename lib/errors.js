// 位图这边对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_VALUE',
  'ERR_BAD_BITMAP',
];

export class RoarbitError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RoarbitError';
    this.code = code;
    this.details = details;
  }
}
