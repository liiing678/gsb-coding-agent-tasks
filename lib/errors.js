// 查询引擎对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_CONFIG',
  'ERR_BAD_QUERY',
  'ERR_UNKNOWN_TABLE',
  'ERR_UNKNOWN_COLUMN',
  'ERR_BAD_AGG',
];

export class QueryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'QueryError';
    this.code = code;
    this.details = details;
  }
}
