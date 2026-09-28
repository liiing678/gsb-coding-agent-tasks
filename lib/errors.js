// 前缀表对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_PREFIX',
  'ERR_BAD_ADDRESS',
  'ERR_BAD_ARGUMENT',
];

export class CidrError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CidrError';
    this.code = code;
    this.details = details;
  }
}
