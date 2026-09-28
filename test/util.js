import { AvlError } from '../lib/errors.js';

export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof AvlError ? err.code : `NOT_AVL:${err.message}`;
  }
};

export const sortedKeys = (map) => [...map.keys()].sort((left, right) => left - right);

// AVL 树高度的上界：h <= 1.4405 * log2(n + 2) - 0.3277（斐波那契那套）
export const heightBound = (size) => Math.floor(1.4405 * Math.log2(size + 2) - 0.3277);

export class Rand {
  constructor(seed = 1) {
    this.state = seed >>> 0 || 1;
  }

  next() {
    this.state = (this.state * 1103515245 + 12345) & 0x7fffffff;
    return this.state;
  }

  below(limit) {
    return this.next() % limit;
  }
}