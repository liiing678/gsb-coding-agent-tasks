// 记账对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_CONFIG',
  'ERR_BAD_ARGS',
  'ERR_BAD_ENTRY',
  'ERR_DUPLICATE_ENTRY',
  'ERR_UNKNOWN_ACCOUNT',
  'ERR_UNKNOWN_ENTRY',
  'ERR_BAD_AMOUNT',
  'ERR_UNBALANCED',
  'ERR_PERIOD_LOCKED',
  'ERR_ALREADY_REVERSED',
];

export class LedgerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.details = details;
  }
}
