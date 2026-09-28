// DEFLATE 这边对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_INPUT',
  'ERR_TRUNCATED',
  'ERR_BAD_BLOCK',
  'ERR_BAD_HUFFMAN',
  'ERR_BAD_LENGTH',
  'ERR_BAD_DISTANCE',
  'ERR_BAD_ZLIB',
  'ERR_CHECKSUM',
];

export class FlateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FlateError';
    this.code = code;
    this.details = details;
  }
}