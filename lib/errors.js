export const CODES = [
  'ERR_BAD_DOC',
  'ERR_DUP_ID',
  'ERR_UNKNOWN_DOC',
  'ERR_BAD_QUERY',
  'ERR_BAD_SNAPSHOT',
];

export class IndexError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'IndexError';
    this.code = code;
    this.details = details;
  }
}
