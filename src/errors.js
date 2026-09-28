// 错误的 code 就这些，别改名、也别再发明别的（README 里有清单和含义）。
export const ERROR_CODES = [
  'invalid_request',
  'invalid_token',
  'unknown_kid',
  'key_expired',
  'bad_signature',
  'expired',
  'not_yet_valid',
  'wrong_typ',
  'wrong_issuer',
  'revoked',
  'session_revoked',
  'refresh_replayed',
  'revocation_capacity_exceeded',
];

export class TokenError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'TokenError';
    this.code = code;
  }
}
