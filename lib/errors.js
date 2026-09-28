// 等待图对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_CONFIG',
  'ERR_BAD_ARGS',
  'ERR_UNKNOWN_TX',
  'ERR_DUPLICATE_TX',
  'ERR_TX_ABORTED',
  'ERR_ALREADY_WAITING',
  'ERR_ALREADY_HOLDER',
  'ERR_UNKNOWN_RESOURCE',
  'ERR_NOT_HOLDER',
];

export class WaitError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WaitError';
    this.code = code;
    this.details = details;
  }
}
