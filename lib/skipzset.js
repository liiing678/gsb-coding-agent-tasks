import { ZsetError } from './errors.js';

const MAX_LEVEL = 32;

const badArgument = (message) => new ZsetError('ERR_BAD_ARGUMENT', message);
const badBound = (message) => new ZsetError('ERR_BAD_BOUND', message);

const compareMembers = (left, right) => {
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

const compareEntries = (left, right) => {
  if (left.score !== right.score) {
    return left.score < right.score ? -1 : 1;
  }
  return compareMembers(left.member, right.member);
};

const assertMember = (member) => {
  if (typeof member !== 'string' || member.length === 0) {
    throw badArgument('member 必须是非空字符串');
  }
};

const assertScore = (score) => {
  if (!Number.isFinite(score)) {
    throw badArgument('score 必须是有限数字');
  }
};

const assertIndex = (value, name) => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw badArgument(`${name} 必须是整数`);
  }
};

const assertScoreBound = (value, name) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw badArgument(`${name} 必须是数字`);
  }
};

class Node {
  constructor(member, score, level) {
    this.member = member;
    this.score = score;
    this.forward = new Array(level).fill(null);
  }
}

const makeHeader = () => ({
  forward: new Array(MAX_LEVEL).fill(null),
});

const parseLexBound = (value) => {
  if (typeof value !== 'string') {
    throw badBound('字典序边界必须是字符串');
  }
  if (value === '-' || value === '+') return { edge: value };
  const marker = value[0];
  if (marker === '[' || marker === '(') {
    return {
      inclusive: marker === '[',
      value: value.slice(1),
    };
  }
  throw badBound('字典序边界必须是 -、+、[值 或 (值)');
};

const matchesLexLower = (member, bound) => {
  if (bound.edge === '-') return true;
  if (bound.edge === '+') return false;
  const compared = compareMembers(member, bound.value);
  return bound.inclusive ? compared >= 0 : compared > 0;
};

const matchesLexUpper = (member, bound) => {
  if (bound.edge === '+') return true;
  if (bound.edge === '-') return false;
  const compared = compareMembers(member, bound.value);
  return bound.inclusive ? compared <= 0 : compared < 0;
};

export class Zset {
  constructor() {
    this.header = makeHeader();
    this.nodes = new Map();
    this.level = 0;
  }

  add(member, score) {
    assertMember(member);
    assertScore(score);

    const existing = this.nodes.get(member);
    const wasAdded = existing ? 0 : 1;
    if (existing) this.removeNode(existing);

    const nodeLevel = this.randomLevel();
    const node = existing ?? new Node(member, score, nodeLevel);
    node.score = score;
    node.forward = new Array(nodeLevel).fill(null);
    this.insertNode(node, nodeLevel);
    this.nodes.set(member, node);

    return wasAdded;
  }

  remove(member) {
    assertMember(member);

    const node = this.nodes.get(member);
    if (!node) return 0;

    this.removeNode(node);
    this.nodes.delete(member);
    return 1;
  }

  score(member) {
    assertMember(member);
    return this.nodes.get(member)?.score ?? null;
  }

  size() {
    return this.nodes.size;
  }

  clear() {
    this.header = makeHeader();
    this.nodes.clear();
    this.level = 0;
  }

  rank(member) {
    assertMember(member);
    if (!this.nodes.has(member)) return null;

    let rank = 0;
    let node = this.header.forward[0];
    while (node && node.member !== member) {
      rank += 1;
      node = node.forward[0];
    }
    return rank;
  }

  revRank(member) {
    const rank = this.rank(member);
    return rank === null ? null : this.nodes.size - rank - 1;
  }

  range(start, stop) {
    assertIndex(start, 'start');
    assertIndex(stop, 'stop');

    const total = this.nodes.size;
    let from = start < 0 ? total + start : start;
    let to = stop < 0 ? total + stop : stop;

    if (from < 0) from = 0;
    if (to >= total) to = total - 1;
    if (total === 0 || from > to || from >= total) return [];

    const result = [];
    let index = 0;
    let node = this.header.forward[0];

    while (node && index < from) {
      node = node.forward[0];
      index += 1;
    }

    while (node && index <= to) {
      result.push(node.member);
      node = node.forward[0];
      index += 1;
    }

    return result;
  }

  rangeByScore(min, max) {
    assertScoreBound(min, 'min');
    assertScoreBound(max, 'max');
    if (min > max) return [];

    const result = [];
    let node = this.header.forward[0];
    while (node) {
      if (node.score > max) break;
      if (node.score >= min) result.push(node.member);
      node = node.forward[0];
    }
    return result;
  }

  countByScore(min, max) {
    return this.rangeByScore(min, max).length;
  }

  rangeByLex(min, max) {
    const lower = parseLexBound(min);
    const upper = parseLexBound(max);

    return [...this.nodes.keys()]
      .sort(compareMembers)
      .filter((member) => matchesLexLower(member, lower) && matchesLexUpper(member, upper));
  }

  entries() {
    const result = [];
    let node = this.header.forward[0];
    while (node) {
      result.push([node.member, node.score]);
      node = node.forward[0];
    }
    return result;
  }

  randomLevel() {
    let level = 1;
    while (level < MAX_LEVEL && Math.random() < 0.5) level += 1;
    return level;
  }

  insertNode(node, nodeLevel) {
    const update = new Array(MAX_LEVEL).fill(this.header);
    let current = this.header;

    for (let level = this.level - 1; level >= 0; level -= 1) {
      let next = current.forward[level];
      while (next && compareEntries(next, node) < 0) {
        current = next;
        next = current.forward[level];
      }
      update[level] = current;
    }

    for (let level = 0; level < nodeLevel; level += 1) {
      node.forward[level] = update[level].forward[level];
      update[level].forward[level] = node;
    }

    if (nodeLevel > this.level) this.level = nodeLevel;
  }

  removeNode(target) {
    const update = new Array(MAX_LEVEL).fill(this.header);
    let current = this.header;

    for (let level = this.level - 1; level >= 0; level -= 1) {
      let next = current.forward[level];
      while (next && compareEntries(next, target) < 0) {
        current = next;
        next = current.forward[level];
      }
      update[level] = current;
    }

    for (let level = 0; level < this.level; level += 1) {
      if (update[level].forward[level] !== target) continue;
      update[level].forward[level] = target.forward[level];
    }

    while (this.level > 0 && this.header.forward[this.level - 1] === null) {
      this.level -= 1;
    }
  }
}

export function createZset() {
  return new Zset();
}
