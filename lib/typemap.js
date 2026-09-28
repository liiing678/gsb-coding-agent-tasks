import { IndexError } from './errors.js';

const BAD_ARGUMENT = 'ERR_BAD_ARGUMENT';
const BUDGET_EXCEEDED = 'ERR_BUDGET_EXCEEDED';

const badArgument = () => new IndexError(BAD_ARGUMENT, 'bad argument', {});

const assertTerm = (term) => {
  if (typeof term !== 'string' || term.length === 0) throw badArgument();
};

const assertWeight = (weight) => {
  if (!Number.isFinite(weight)) throw badArgument();
};

const resolveLimit = (limit) => {
  if (limit === undefined) return 10;
  if (!Number.isInteger(limit) || limit < 0) throw badArgument();
  return limit;
};

const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const compareByTerm = (left, right) => {
  if (left.weight !== right.weight) return right.weight - left.weight;
  if (left.term < right.term) return -1;
  if (left.term > right.term) return 1;
  return 0;
};

const compareEdges = (left, right) => {
  if (left.label < right.label) return -1;
  if (left.label > right.label) return 1;
  return 0;
};

export function createIndex(entries = []) {
  if (!Array.isArray(entries)) throw badArgument();

  const root = { children: new Map(), terminal: false, weight: null };
  let termCount = 0;

  const makeTerminal = (weight) => ({
    children: new Map(),
    terminal: true,
    weight,
  });

  const insert = (term, weight = 1) => {
    assertTerm(term);
    assertWeight(weight);

    let node = root;
    let position = 0;

    while (position < term.length) {
      const edge = node.children.get(term[position]);
      if (!edge) {
        node.children.set(term[position], {
          label: term.slice(position),
          node: makeTerminal(weight),
        });
        termCount += 1;
        return true;
      }

      let common = 0;
      const maxCommon = Math.min(edge.label.length, term.length - position);
      while (common < maxCommon && edge.label[common] === term[position + common]) {
        common += 1;
      }

      if (common === edge.label.length) {
        node = edge.node;
        position += common;
        continue;
      }

      const middle = { children: new Map(), terminal: false, weight: null };
      middle.children.set(edge.label[common], {
        label: edge.label.slice(common),
        node: edge.node,
      });

      if (position + common === term.length) {
        middle.terminal = true;
        middle.weight = weight;
      } else {
        middle.children.set(term[position + common], {
          label: term.slice(position + common),
          node: makeTerminal(weight),
        });
      }

      node.children.set(edge.label[0], {
        label: edge.label.slice(0, common),
        node: middle,
      });
      termCount += 1;
      return true;
    }

    if (node.terminal) {
      node.weight = weight;
      return false;
    }

    node.terminal = true;
    node.weight = weight;
    termCount += 1;
    return true;
  };

  for (const entry of entries) {
    if (typeof entry === 'string') {
      insert(entry);
    } else if (Array.isArray(entry) && entry.length === 2) {
      assertTerm(entry[0]);
      assertWeight(entry[1]);
      insert(entry[0], entry[1]);
    } else {
      throw badArgument();
    }
  }

  const find = (term) => {
    const stack = [];
    let node = root;
    let position = 0;

    while (position < term.length) {
      const edge = node.children.get(term[position]);
      if (!edge || !term.startsWith(edge.label, position)) return null;
      stack.push({ parent: node, edge, node: edge.node });
      node = edge.node;
      position += edge.label.length;
    }

    return node.terminal ? { node, stack } : null;
  };

  const mergeIntoParent = (edge, node) => {
    const onlyEdge = node.children.values().next().value;
    edge.label += onlyEdge.label;
    edge.node = onlyEdge.node;
  };

  const remove = (term) => {
    assertTerm(term);
    const found = find(term);
    if (!found) return false;

    const { node, stack } = found;
    node.terminal = false;
    node.weight = null;
    termCount -= 1;

    if (node.children.size === 1) {
      mergeIntoParent(stack[stack.length - 1].edge, node);
      return true;
    }

    if (node.children.size !== 0) return true;

    let frame = stack.pop();
    frame.parent.children.delete(frame.edge.label[0]);
    let parent = frame.parent;

    while (parent !== root && !parent.terminal) {
      if (parent.children.size >= 2) break;
      if (parent.children.size === 1) {
        mergeIntoParent(stack[stack.length - 1].edge, parent);
        break;
      }

      frame = stack.pop();
      frame.parent.children.delete(frame.edge.label[0]);
      parent = frame.parent;
    }

    return true;
  };

  const collect = (node, prefix, output) => {
    if (node.terminal) output.push({ term: prefix, weight: node.weight });
    for (const edge of node.children.values()) {
      collect(edge.node, prefix + edge.label, output);
    }
  };

  const top = (limit = 10) => {
    const resolvedLimit = resolveLimit(limit);
    if (resolvedLimit === 0) return [];

    const output = [];
    collect(root, '', output);
    return output.sort(compareByTerm).slice(0, resolvedLimit);
  };

  const prefix = (queryPrefix, limit = 10) => {
    if (typeof queryPrefix !== 'string') throw badArgument();
    const resolvedLimit = resolveLimit(limit);
    if (resolvedLimit === 0) return [];

    let node = root;
    let position = 0;
    let path = '';

    while (position < queryPrefix.length) {
      const edge = node.children.get(queryPrefix[position]);
      if (!edge) return [];

      if (queryPrefix.startsWith(edge.label, position)) {
        path += edge.label;
        position += edge.label.length;
        node = edge.node;
        continue;
      }

      const segment = queryPrefix.slice(position);
      if (!edge.label.startsWith(segment)) return [];

      path += edge.label;
      node = edge.node;
      position = queryPrefix.length;
      break;
    }

    const output = [];
    collect(node, path, output);
    return output.sort(compareByTerm).slice(0, resolvedLimit);
  };

  const advanceRow = (row, label, term) => {
    let current = row;

    for (let index = 0; index < label.length; index += 1) {
      const codeUnit = label[index];
      const next = [current[0] + 1];

      for (let column = 1; column <= term.length; column += 1) {
        const cost = codeUnit === term[column - 1] ? 0 : 1;
        next[column] = Math.min(
          current[column] + 1,
          next[column - 1] + 1,
          current[column - 1] + cost,
        );
      }

      current = next;
    }

    return current;
  };

  const fuzzy = (term, maxDistance, limit = 10, options = {}) => {
    assertTerm(term);
    if (!Number.isInteger(maxDistance) || maxDistance < 0) throw badArgument();
    const resolvedLimit = resolveLimit(limit);
    if (!isPlainObject(options)) throw badArgument();

    let maxVisits = 20000;
    if (options.maxVisits !== undefined) {
      if (!Number.isInteger(options.maxVisits) || options.maxVisits <= 0) throw badArgument();
      maxVisits = options.maxVisits;
    }

    const initialRow = Array.from({ length: term.length + 1 }, (_, index) => index);
    const matches = [];
    let visits = 0;

    const visit = (node, path, row) => {
      visits += 1;
      if (visits > maxVisits) {
        throw new IndexError(BUDGET_EXCEEDED, 'visit budget exceeded', { visits });
      }

      if (node.terminal && row[term.length] <= maxDistance) {
        matches.push({
          term: path,
          weight: node.weight,
          distance: row[term.length],
        });
      }

      const edges = [...node.children.values()].sort(compareEdges);
      for (const edge of edges) {
        const nextRow = advanceRow(row, edge.label, term);
        let minimum = nextRow[0];
        for (let index = 1; index < nextRow.length; index += 1) {
          if (nextRow[index] < minimum) minimum = nextRow[index];
        }
        if (minimum <= maxDistance) visit(edge.node, path + edge.label, nextRow);
      }
    };

    visit(root, '', initialRow);

    return matches
      .sort((left, right) => left.distance - right.distance || compareByTerm(left, right))
      .slice(0, resolvedLimit)
      .map(({ term: matchedTerm, weight }) => ({ term: matchedTerm, weight }));
  };

  const has = (term) => {
    assertTerm(term);
    return Boolean(find(term));
  };

  const weight = (term) => {
    assertTerm(term);
    const found = find(term);
    return found ? found.node.weight : null;
  };

  const stats = () => {
    let nodes = 0;

    const walk = (node) => {
      if (node === root || node.terminal || node.children.size >= 2) nodes += 1;
      for (const edge of node.children.values()) walk(edge.node);
    };

    walk(root);
    return { terms: termCount, nodes };
  };

  return {
    insert,
    remove,
    has,
    weight,
    prefix,
    fuzzy,
    top,
    stats,
  };
}
