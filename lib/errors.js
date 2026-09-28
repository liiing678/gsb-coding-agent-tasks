export const CODES = [
  'ERR_BAD_SERIES',
  'ERR_BAD_TIME',
  'ERR_BAD_TZ',
  'ERR_BAD_RULE',
  'ERR_UNSUPPORTED_RULE',
  'ERR_BAD_OVERRIDE',
  'ERR_LIMIT_EXCEEDED',
];

export class CalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CalError';
    this.code = code;
    this.details = details;
  }
}
