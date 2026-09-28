// 编解码对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_ARGS',
  'ERR_BAD_SCHEMA',
  'ERR_BAD_VALUE',
  'ERR_BAD_WIRE_TYPE',
  'ERR_TRUNCATED',
  'ERR_VARINT_OVERFLOW',
  'ERR_BAD_UTF8',
  'ERR_MISSING_REQUIRED',
];

export class CodecError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CodecError';
    this.code = code;
    this.details = details;
  }
}
