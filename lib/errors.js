// 开关引擎对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_CONFIG',
  'ERR_BAD_FLAG',
  'ERR_BAD_ROLLOUT',
  'ERR_DUPLICATE_FLAG',
  'ERR_UNKNOWN_FLAG',
  'ERR_FLAG_IN_USE',
  'ERR_FLAG_CYCLE',
  'ERR_BAD_CONTEXT',
];

export class FlagError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FlagError';
    this.code = code;
    this.details = details;
  }
}
