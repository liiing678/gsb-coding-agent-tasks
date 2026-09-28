export const CODES = [
  'ERR_BAD_KEY',
  'ERR_BAD_VALUE',
  'ERR_VALUE_TOO_LARGE',
  'ERR_UNKNOWN_TXN',
  'ERR_TXN_CLOSED',
  'ERR_BAD_VERSION',
  'ERR_PENDING_TXNS',
];

export class KVError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'KVError';
    this.code = code;
    this.details = details;
  }
}
