import { IndexError } from './errors.js';

const badArgument = () => new IndexError('ERR_BAD_ARGUMENT', 'bad argument', {});

const isTerm = (value) => typeof value === 'string' && value.length > 0;
const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const makeNode = (terminal = false, weight = null) => ({
  terminal,
  weight,
  children: new Map(),
});

const commonPrefixLength = (left, right) => {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
};

const compareByCodeUnits = (left, right) => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
};

const sortedEntries = (node) => [...node.children.entries()].sort((left, right) =>
  compareByCodeUnits(left[0], right[0]),
);

const rankCompare = (left, right) => {
  if (left.weight !== right.weight) return right.weight - left.weight;
  if (left.term < right.term) return -1;
  if (left.term > right.term) return 1;
  return 0;
};

const nextDistanceRow = (previous, codeUnit, query) => {
  const next = [previous[0] + 1];
  for (let index = 1; index <= query.length; index += 1) {
    const substitutionCost = query.charCodeAt(index - 1) === codeUnit ? 0 : 1;
    next[index] = Math.min(
      previous[index] + 1,
      next[index - 1] + 1,
      previous[index - 1] + substitutionCost,
    );
  }
  return next;
};

export function createIndex(entries = []) {
  if (!Array.isArray(entries)) throw badArgument();
  for (const entry of entries) {
    if (isTerm(entry)) continue;
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      !isTerm(entry[0]) ||
      !Number.isFinite(entry[1])
    ) {
      throw badArgument();
    }
  }

  const root = makeNode();
  let terms = 0;

  const insertAt = (node, suffix, weight) => {
    const label = [...node.children.keys()].find((key) => key[0] === suffix[0]);

    if (label === undefined) {
      node.children.set(suffix, makeNode(true, weight));
      return true;
    }

    const child = node.children.get(label);
    const shared = commonPrefixLength(label, suffix);

    if (shared === label.length) {
      if (shared === suffix.length) {
        if (child.terminal) {
          child.weight = weight;
          return false;
        }
        child.terminal = true;
        child.weight = weight;
        return true;
      }
      return insertAt(child, suffix.slice(shared), weight);
    }

    const existingTail = makeNode();
    existingTail.terminal = child.terminal;
    existingTail.weight = child.weight;
    existingTail.children = child.children;

    let replacement;
    if (shared === suffix.length) {
      replacement = makeNode(true, weight);
      replacement.children.set(label.slice(shared), existingTail);
    } else {
      replacement = makeNode();
      replacement.children.set(label.slice(shared), existingTail);
      replacement.children.set(suffix.slice(shared), makeNode(true, weight));
    }

    node.children.delete(label);
    node.children.set(label.slice(0, shared), replacement);
    return true;
  };

  const pruneChild = (parent, label, child) => {
    if (!child.terminal && child.children.size === 0) {
      parent.children.delete(label);
      return;
    }
    if (!child.terminal && child.children.size === 1) {
      const [tailLabel, grandchild] = [...child.children.entries()][0];
      parent.children.delete(label);
      parent.children.set(label + tailLabel, grandchild);
    }
  };

  const removeAt = (parent, suffix) => {
    const label = [...parent.children.keys()].find((key) => key[0] === suffix[0]);
    if (label === undefined) return false;

    const child = parent.children.get(label);
    if (suffix.length < label.length) return false;

    const shared = commonPrefixLength(label, suffix);
    if (shared < label.length) return false;

    if (suffix.length === label.length) {
      if (!child.terminal) return false;
      child.terminal = false;
      child.weight = null;
      pruneChild(parent, label, child);
      return true;
    }

    const removed = removeAt(child, suffix.slice(label.length));
    if (removed) pruneChild(parent, label, child);
    return removed;
  };

  const findNode = (term) => {
    let node = root;
    let suffix = term;

    while (suffix.length > 0) {
      const label = [...node.children.keys()].find((key) => key[0] === suffix[0]);
      if (label === undefined || !suffix.startsWith(label)) return null;
      node = node.children.get(label);
      suffix = suffix.slice(label.length);
    }

    return node;
  };

  const collect = (start, startPath) => {
    const found = [];
    const stack = [{ node: start, path: startPath }];

    while (stack.length > 0) {
      const { node, path } = stack.pop();
      if (node.terminal) found.push({ term: path, weight: node.weight });

      const entries = sortedEntries(node);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [label, child] = entries[index];
        stack.push({ node: child, path: path + label });
      }
    }

    return found;
  };

  const locatePrefix = (prefix) => {
    let node = root;
    let suffix = prefix;

    while (suffix.length > 0) {
      const label = [...node.children.keys()].find((key) => key[0] === suffix[0]);
      if (label === undefined) return null;

      const shared = commonPrefixLength(label, suffix);
      if (shared === suffix.length && shared <= label.length) {
        return { node: node.children.get(label), path: prefix + label.slice(shared) };
      }
      if (shared < label.length) return null;

      node = node.children.get(label);
      suffix = suffix.slice(label.length);
    }

    return { node, path: prefix };
  };

  const countNodes = () => {
    let count = 0;
    const stack = [root];

    while (stack.length > 0) {
      const node = stack.pop();
      if (node === root || node.terminal || node.children.size >= 2) count += 1;
      for (const child of node.children.values()) stack.push(child);
    }

    return count;
  };

  const insert = (term, weight = 1) => {
    if (!isTerm(term) || !Number.isFinite(weight)) throw badArgument();
    const inserted = insertAt(root, term, weight);
    if (inserted) terms += 1;
    return inserted;
  };

  const remove = (term) => {
    if (!isTerm(term)) throw badArgument();
    const removed = removeAt(root, term);
    if (removed) terms -= 1;
    return removed;
  };

  const has = (term) => {
    if (!isTerm(term)) throw badArgument();
    const node = findNode(term);
    return node !== null && node.terminal;
  };

  const weight = (term) => {
    if (!isTerm(term)) throw badArgument();
    const node = findNode(term);
    return node !== null && node.terminal ? node.weight : null;
  };

  const top = (limit = 10) => {
    if (!isNonNegativeInteger(limit)) throw badArgument();
    if (limit === 0) return [];
    return collect(root, '').sort(rankCompare).slice(0, limit);
  };

  const prefix = (prefixTerm, limit = 10) => {
    if (typeof prefixTerm !== 'string' || !isNonNegativeInteger(limit)) throw badArgument();
    if (limit === 0) return [];
    if (prefixTerm === '') return top(limit);

    const located = locatePrefix(prefixTerm);
    if (located === null) return [];
    return collect(located.node, located.path).sort(rankCompare).slice(0, limit);
  };

  const fuzzy = (term, maxDistance, limit = 10, options = {}) => {
    if (
      !isTerm(term) ||
      !isNonNegativeInteger(maxDistance) ||
      !isNonNegativeInteger(limit) ||
      !isPlainObject(options)
    ) {
      throw badArgument();
    }

    const maxVisits = options.maxVisits === undefined ? 20000 : options.maxVisits;
    if (!Number.isInteger(maxVisits) || maxVisits <= 0) throw badArgument();
    if (limit === 0) return [];

    const matches = [];
    let visits = 0;

    const visit = (node, row, path) => {
      visits += 1;
      if (visits > maxVisits) {
        throw new IndexError('ERR_BUDGET_EXCEEDED', 'visit budget exceeded', { visits });
      }

      const distance = row[term.length];
      if (node.terminal && distance <= maxDistance) {
        matches.push({ term: path, weight: node.weight, distance });
      }

      for (const [label, child] of sortedEntries(node)) {
        let nextRow = row;
        for (let index = 0; index < label.length; index += 1) {
          nextRow = nextDistanceRow(nextRow, label.charCodeAt(index), term);
        }
        if (Math.min(...nextRow) <= maxDistance) visit(child, nextRow, path + label);
      }
    };

    visit(root, Array.from({ length: term.length + 1 }, (_, index) => index), '');

    matches.sort((left, right) => {
      if (left.distance !== right.distance) return left.distance - right.distance;
      return rankCompare(left, right);
    });

    return matches.slice(0, limit).map(({ term: matchedTerm, weight: matchedWeight }) => ({
      term: matchedTerm,
      weight: matchedWeight,
    }));
  };

  for (const entry of entries) {
    if (Array.isArray(entry)) insert(entry[0], entry[1]);
    else insert(entry, 1);
  }

  return {
    insert,
    remove,
    has,
    weight,
    prefix,
    fuzzy,
    top,
    stats: () => ({ terms, nodes: countNodes() }),
  };
}
