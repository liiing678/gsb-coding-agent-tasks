// 排序器对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_CONFIG',
  'ERR_BAD_VALUE',
  'ERR_STATE',
  'ERR_IO',
];

export class MergeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MergeError';
    this.code = code;
    this.details = details;
  }
}
