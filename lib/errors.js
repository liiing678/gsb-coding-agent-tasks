// Merkle 这边对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_ARGUMENT',
  'ERR_OUT_OF_RANGE',
];

export class MerkleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MerkleError';
    this.code = code;
    this.details = details;
  }
}
