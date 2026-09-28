// 日志复制这边对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_CONFIG',
  'ERR_NOT_LEADER',
  'ERR_LOG_MISSING',
  'ERR_BAD_MESSAGE',
];

export class RaftlogError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RaftlogError';
    this.code = code;
    this.details = details;
  }
}
