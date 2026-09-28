// 协调器对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_CONFIG',
  'ERR_BAD_TXN',
  'ERR_DUPLICATE_TXN',
  'ERR_UNKNOWN_TXN',
  'ERR_UNKNOWN_PARTICIPANT',
  'ERR_BAD_MESSAGE',
  'ERR_BAD_STATE',
];

export class TwopcError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TwopcError';
    this.code = code;
    this.details = details;
  }
}
