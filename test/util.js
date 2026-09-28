import { ZsetError } from '../lib/errors.js';

export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof ZsetError ? err.code : `NOT_ZSET:${err.message}`;
  }
};

export const naiveOrder = (map) => [...map]
  .map(([member, score]) => ({ member, score }))
  .sort((left, right) => {
    if (left.score !== right.score) return left.score < right.score ? -1 : 1;
    if (left.member === right.member) return 0;
    return left.member < right.member ? -1 : 1;
  });

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