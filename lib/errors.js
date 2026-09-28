// 事务存储对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_CONFIG',
  'ERR_BAD_KEY',
  'ERR_BAD_VALUE',
  'ERR_BAD_RANGE',
  'ERR_TXN_CLOSED',
  'ERR_CONFLICT',
];

export class MvccError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MvccError';
    this.code = code;
    this.details = details;
  }
}
