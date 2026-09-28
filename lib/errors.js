// 编解码对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_INPUT',
  'ERR_BAD_OPTIONS',
  'ERR_BAD_HEADER',
  'ERR_TRUNCATED',
  'ERR_CHECKSUM',
];

export class TscodecError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TscodecError';
    this.code = code;
    this.details = details;
  }
}
