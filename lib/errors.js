// 签名器对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_REQUEST',
  'ERR_BAD_CREDENTIALS',
  'ERR_BAD_TIMESTAMP',
  'ERR_BAD_ARGS',
];

export class ReqsignError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReqsignError';
    this.code = code;
    this.details = details;
  }
}
