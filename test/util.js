import { createLog } from '../lib/merkletree.js';

export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

export const leavesOf = (n) => Array.from({ length: n }, (_, i) => `leaf-${i}`);

export const logOf = (n) => {
  const log = createLog();
  log.appendAll(leavesOf(n));
  return log;
};

export const flip = (hex) => (hex[0] === '0' ? `1${hex.slice(1)}` : `0${hex.slice(1)}`);
