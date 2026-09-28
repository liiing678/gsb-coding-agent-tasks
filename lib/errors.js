// 会话引擎对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_REQUEST',
  'ERR_UNKNOWN_UPLOAD',
  'ERR_NOT_OPEN',
  'ERR_CHUNK_OUT_OF_RANGE',
  'ERR_CHUNK_SIZE',
  'ERR_BAD_HASH',
  'ERR_CHUNK_HASH_MISMATCH',
  'ERR_CHUNK_CONFLICT',
  'ERR_STORE_FULL',
  'ERR_INCOMPLETE',
  'ERR_FINGERPRINT_MISMATCH',
  'ERR_BAD_SNAPSHOT',
];

export class RelayError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.details = details;
  }
}
