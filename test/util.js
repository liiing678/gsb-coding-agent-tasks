import { IndexError } from '../lib/errors.js';

export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof IndexError ? err.code : `NOT_INDEX:${err.message}`;
  }
};

export const byRank = (left, right) => {
  if (left.weight !== right.weight) return right.weight - left.weight;
  if (left.term < right.term) return -1;
  if (left.term > right.term) return 1;
  return 0;
};

export const expectedTop = (model, limit) =>
  [...model.entries()]
    .map(([term, weight]) => ({ term, weight }))
    .sort(byRank)
    .slice(0, limit);

export const expectedPrefix = (model, prefix, limit) =>
  expectedTop(new Map([...model].filter(([term]) => term.startsWith(prefix))), limit);

export const distance = (left, right) => {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => index);
  for (let column = 1; column <= right.length; column += 1) {
    const step = [column];
    for (let row = 1; row <= left.length; row += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      step.push(Math.min(rows[row] + 1, step[row - 1] + 1, rows[row - 1] + cost));
    }
    rows.length = 0;
    rows.push(...step);
  }
  return rows[left.length];
};

export const expectedFuzzy = (model, term, maxDistance, limit) =>
  [...model.entries()]
    .map(([word, weight]) => ({ term: word, weight, distance: distance(word, term) }))
    .filter((item) => item.distance <= maxDistance)
    .sort((left, right) => left.distance - right.distance || byRank(left, right))
    .slice(0, limit)
    .map(({ term: word, weight }) => ({ term: word, weight }));

// 规范节点数：普通 trie 里「根、词尾、岔路口」这三个位置才有节点
export const expectedNodes = (terms) => {
  const root = { children: new Map(), terminal: false };
  for (const term of terms) {
    let node = root;
    for (let index = 0; index < term.length; index += 1) {
      const character = term[index];
      if (!node.children.has(character)) {
        node.children.set(character, { children: new Map(), terminal: false });
      }
      node = node.children.get(character);
    }
    node.terminal = true;
  }
  let count = 0;
  const walk = (node) => {
    if (node === root || node.terminal || node.children.size >= 2) count += 1;
    for (const child of node.children.values()) walk(child);
  };
  walk(root);
  return count;
};

export const mulberry32 = (seed) => () => {
  let state = (seed += 0x6d2b79f5);
  state = Math.imul(state ^ (state >>> 15), state | 1);
  state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
  return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
};

export const randomWord = (random, length) => {
  const alphabet = 'abc';
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += alphabet[Math.floor(random() * alphabet.length)];
  }
  return out;
};
