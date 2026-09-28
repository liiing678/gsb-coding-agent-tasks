// 有序集合这边对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_ARGUMENT',
  'ERR_BAD_BOUND',
];

export class ZsetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ZsetError';
    this.code = code;
    this.details = details;
  }
}