// 决策引擎对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_POLICY',
  'ERR_BAD_REQUEST',
  'ERR_ACCESS_DENIED',
];

export class PolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
    this.details = details;
  }
}
