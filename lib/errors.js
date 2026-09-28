// 路由这边对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_ARGUMENT',
  'ERR_UNKNOWN_NODE',
];

export class RouteError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RouteError';
    this.code = code;
    this.details = details;
  }
}
