// 匹配器对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_PATTERNS',
  'ERR_BAD_ARGS',
  'ERR_STREAM_CLOSED',
];

export class MatchgridError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MatchgridError';
    this.code = code;
    this.details = details;
  }
}
