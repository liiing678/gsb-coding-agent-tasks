// patch 这边对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_POINTER',
  'ERR_PATH_MISSING',
  'ERR_BAD_PATCH',
  'ERR_TEST_FAILED',
];

export class JsonpatchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'JsonpatchError';
    this.code = code;
    this.details = details;
  }
}
