// 有序集合内核：按（分数升序，成员升序）排队，外加名次与几种区间查询。
//
// 内部维护两份数据：_scores 是 member -> score 的映射，_sorted 是按
// （分数升序，成员升序）排好的 { member, score } 数组，写操作同步更新两边，
// 名次与区间查询在 _sorted 上二分。

import { ZsetError } from './errors.js';

const badArgument = (message, details) => new ZsetError('ERR_BAD_ARGUMENT', message, details);
const badBound = (message, details) => new ZsetError('ERR_BAD_BOUND', message, details);

const checkMember = (member) => {
  if (typeof member !== 'string' || member.length === 0) {
    throw badArgument('member 必须是非空字符串', { member });
  }
};

const checkScore = (score) => {
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw badArgument('score 必须是有限数字', { score });
  }
};

const checkIndex = (index, name) => {
  if (!Number.isInteger(index)) {
    throw badArgument(`${name} 必须是整数`, { [name]: index });
  }
};

const checkScoreBound = (bound, name) => {
  if (typeof bound !== 'number' || Number.isNaN(bound)) {
    throw badArgument(`${name} 必须是数字（可以是 ±Infinity）`, { [name]: bound });
  }
};

// 字典序区间的边界：'-' 最小、'+' 最大、'[x' 含 x、'(x' 不含 x，其余一律 ERR_BAD_BOUND。
const parseLexBound = (raw) => {
  if (raw === '-') return { kind: 'min' };
  if (raw === '+') return { kind: 'max' };
  if (typeof raw === 'string' && raw.length > 0 && (raw[0] === '[' || raw[0] === '(')) {
    return { kind: 'value', inclusive: raw[0] === '[', value: raw.slice(1) };
  }
  throw badBound('字典序边界只接受 "-" / "+" / "[值" / "(值"', { bound: raw });
};

const compareEntries = (left, right) => {
  if (left.score !== right.score) return left.score < right.score ? -1 : 1;
  if (left.member === right.member) return 0;
  return left.member < right.member ? -1 : 1;
};

export class Zset {
  constructor() {
    this._scores = new Map();
    this._sorted = [];
  }

  // 第一个 >= key 的下标；key 是 { member, score }。
  _lowerBound(key) {
    let lo = 0;
    let hi = this._sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareEntries(this._sorted[mid], key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // 第一个 score 严格大于 value 的下标。
  _upperScoreBound(value) {
    let lo = 0;
    let hi = this._sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._sorted[mid].score <= value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  add(member, score) {
    checkMember(member);
    checkScore(score);
    const previous = this._scores.get(member);
    if (previous !== undefined) {
      if (previous === score) return 0;
      this._sorted.splice(this._lowerBound({ member, score: previous }), 1);
    }
    this._scores.set(member, score);
    this._sorted.splice(this._lowerBound({ member, score }), 0, { member, score });
    return previous === undefined ? 1 : 0;
  }

  remove(member) {
    checkMember(member);
    const score = this._scores.get(member);
    if (score === undefined) return 0;
    this._scores.delete(member);
    this._sorted.splice(this._lowerBound({ member, score }), 1);
    return 1;
  }

  score(member) {
    checkMember(member);
    const score = this._scores.get(member);
    return score === undefined ? null : score;
  }

  size() {
    return this._scores.size;
  }

  clear() {
    this._scores.clear();
    this._sorted = [];
  }

  rank(member) {
    checkMember(member);
    const score = this._scores.get(member);
    if (score === undefined) return null;
    return this._lowerBound({ member, score });
  }

  revRank(member) {
    checkMember(member);
    const score = this._scores.get(member);
    if (score === undefined) return null;
    return this._sorted.length - 1 - this._lowerBound({ member, score });
  }

  range(start, stop) {
    checkIndex(start, 'start');
    checkIndex(stop, 'stop');
    const total = this._sorted.length;
    let from = start < 0 ? total + start : start;
    let to = stop < 0 ? total + stop : stop;
    if (from < 0) from = 0;
    if (to >= total) to = total - 1;
    if (total === 0 || from > to || from >= total) return [];
    return this._sorted.slice(from, to + 1).map((entry) => entry.member);
  }

  rangeByScore(min, max) {
    checkScoreBound(min, 'min');
    checkScoreBound(max, 'max');
    if (min > max) return [];
    const from = this._lowerBound({ member: '', score: min });
    const to = this._upperScoreBound(max);
    return this._sorted.slice(from, to).map((entry) => entry.member);
  }

  countByScore(min, max) {
    checkScoreBound(min, 'min');
    checkScoreBound(max, 'max');
    if (min > max) return 0;
    return this._upperScoreBound(max) - this._lowerBound({ member: '', score: min });
  }

  rangeByLex(min, max) {
    const low = parseLexBound(min);
    const high = parseLexBound(max);
    const aboveLow = (member) => {
      if (low.kind === 'min') return true;
      if (low.kind === 'max') return false;
      return low.inclusive ? member >= low.value : member > low.value;
    };
    const belowHigh = (member) => {
      if (high.kind === 'max') return true;
      if (high.kind === 'min') return false;
      return high.inclusive ? member <= high.value : member < high.value;
    };
    return [...this._scores.keys()]
      .sort()
      .filter((member) => aboveLow(member) && belowHigh(member));
  }

  entries() {
    return this._sorted.map((entry) => [entry.member, entry.score]);
  }
}

export function createZset() {
  return new Zset();
}
