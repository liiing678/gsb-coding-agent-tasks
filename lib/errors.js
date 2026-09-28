export const CODES = [
  'ERR_UNKNOWN_TENANT',
  'ERR_BAD_CONFIG',
  'ERR_COST_TOO_LARGE',
  'ERR_BAD_SNAPSHOT',
];

export class GateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GateError';
    this.code = code;
    this.details = details;
  }
}
