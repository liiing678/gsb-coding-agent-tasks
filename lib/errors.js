// 版本向量这边对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_CLOCK',
  'ERR_BAD_DOT',
  'ERR_BAD_MESSAGE',
];

export class VclockError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VclockError';
    this.code = code;
    this.details = details;
  }
}
