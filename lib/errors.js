// 打包器对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_ARGS',
  'ERR_BAD_HEADER',
  'ERR_CORRUPT',
];

export class PackError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PackError';
    this.code = code;
    this.details = details;
  }
}
