// 多模式匹配（Aho–Corasick）与流式扫描。

import { MatchgridError } from './errors.js';

const foldCache = new Map();

function foldCodePoint(codePoint, ignoreCase) {
  if (!ignoreCase) return codePoint;
  let folded = foldCache.get(codePoint);
  if (folded === undefined) {
    const chars = Array.from(String.fromCodePoint(codePoint).toLowerCase());
    folded = chars.length === 1 ? chars[0].codePointAt(0) : codePoint;
    foldCache.set(codePoint, folded);
  }
  return folded;
}

function toCodePoints(value, ignoreCase) {
  const codePoints = [];
  for (const char of value) {
    codePoints.push(foldCodePoint(char.codePointAt(0), ignoreCase));
  }
  return codePoints;
}

function badPatterns(message) {
  return new MatchgridError('ERR_BAD_PATTERNS', message);
}

function badArgs(message) {
  return new MatchgridError('ERR_BAD_ARGS', message);
}

function validateOptions(options) {
  if (options === null || typeof options !== 'object') {
    throw badArgs('options 必须是对象');
  }
  if (options.ignoreCase !== undefined && typeof options.ignoreCase !== 'boolean') {
    throw badArgs('ignoreCase 必须是布尔值');
  }
  const { maxMatches } = options;
  if (maxMatches !== undefined && (!Number.isInteger(maxMatches) || maxMatches <= 0)) {
    throw badArgs('maxMatches 必须是正整数');
  }
}

function compile(patterns, ignoreCase) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw badPatterns('patterns 必须是非空数组');
  }

  const root = {
    depth: 0,
    next: new Map(),
    fail: null,
    id: -1,
    outputs: [],
  };
  const sources = [];
  const lengths = [];
  const seen = new Set();

  for (let patternIndex = 0; patternIndex < patterns.length; patternIndex += 1) {
    const pattern = patterns[patternIndex];
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw badPatterns('patterns 中的每一项都必须是非空字符串');
    }

    const codePoints = toCodePoints(pattern, ignoreCase);
    const key = codePoints.join(',');
    if (seen.has(key)) {
      throw badPatterns('patterns 在折叠后不能重复');
    }
    seen.add(key);

    let node = root;
    for (const codePoint of codePoints) {
      let child = node.next.get(codePoint);
      if (child === undefined) {
        child = {
          depth: node.depth + 1,
          next: new Map(),
          fail: root,
          id: -1,
          outputs: [],
        };
        node.next.set(codePoint, child);
      }
      node = child;
    }
    node.id = patternIndex;
    sources[patternIndex] = pattern;
    lengths[patternIndex] = codePoints.length;
  }

  const queue = [];
  for (const child of root.next.values()) {
    child.fail = root;
    queue.push(child);
  }

  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    node.outputs = node.id === -1
      ? node.fail.outputs.slice()
      : [node.id, ...node.fail.outputs];
    node.outputs.sort((left, right) => {
      const lengthDifference = lengths[right] - lengths[left];
      return lengthDifference !== 0 ? lengthDifference : left - right;
    });

    for (const [codePoint, child] of node.next) {
      let fallback = node.fail;
      while (fallback !== null && !fallback.next.has(codePoint)) {
        fallback = fallback.fail;
      }
      child.fail = fallback === null ? root : fallback.next.get(codePoint);
      queue.push(child);
    }
  }

  return {
    root,
    sources,
    lengths,
    ignoreCase,
    step(state, codePoint) {
      const folded = foldCodePoint(codePoint, ignoreCase);
      let current = state;
      while (current !== root && !current.next.has(folded)) {
        current = current.fail;
      }
      return current.next.get(folded) ?? root;
    },
    pending(state) {
      let current = state;
      while (current !== root) {
        if (current.next.size > 0) return current.depth;
        current = current.fail;
      }
      return 0;
    },
  };
}

function runFull(machine, text, maxMatches) {
  const matches = [];
  let state = machine.root;
  let emitted = 0;
  let position = 0;
  let truncated = false;

  for (const char of text) {
    state = machine.step(state, char.codePointAt(0));
    for (const id of state.outputs) {
      const length = machine.lengths[id];
      if (emitted < maxMatches) {
        matches.push({
          pattern: machine.sources[id],
          index: position - length + 1,
          length,
        });
        emitted += 1;
      } else {
        truncated = true;
      }
    }
    position += 1;
  }

  return { matches, truncated };
}

function createScannerState(machine, maxMatches) {
  let state = machine.root;
  let fed = 0;
  let held = '';
  let emitted = 0;
  let truncated = false;
  let closedSnapshot = null;
  const reported = [];

  function snapshot(closed) {
    return {
      fed,
      pending: machine.pending(state),
      total: emitted,
      truncated,
      closed,
    };
  }

  return {
    push(chunk) {
      if (closedSnapshot !== null) {
        throw new MatchgridError('ERR_STREAM_CLOSED', '扫描器已经封口');
      }
      if (typeof chunk !== 'string') {
        throw badArgs('push 的文本必须是字符串');
      }

      let data = held + chunk;
      held = '';
      const lastUnit = data.length === 0 ? Number.NaN : data.charCodeAt(data.length - 1);
      if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
        held = data.slice(-1);
        data = data.slice(0, -1);
      }

      const matches = [];
      let offset = 0;
      for (const char of data) {
        state = machine.step(state, char.codePointAt(0));
        for (const id of state.outputs) {
          const length = machine.lengths[id];
          if (emitted < maxMatches) {
            const match = {
              pattern: machine.sources[id],
              index: fed + offset - length + 1,
              length,
            };
            matches.push(match);
            reported.push(match);
            emitted += 1;
          } else {
            truncated = true;
          }
        }
        offset += 1;
      }
      fed += offset;
      return matches;
    },
    all() {
      return reported.slice();
    },
    state() {
      return closedSnapshot ?? snapshot(false);
    },
    end() {
      if (closedSnapshot === null) {
        closedSnapshot = snapshot(true);
      }
      return closedSnapshot;
    },
  };
}

export function createMatcher(patterns, options = {}) {
  validateOptions(options);
  const machine = compile(patterns, options.ignoreCase ?? false);
  const maxMatches = options.maxMatches ?? Number.POSITIVE_INFINITY;
  const storedPatterns = patterns.slice();

  return {
    patterns: storedPatterns,
    scan(text) {
      if (typeof text !== 'string') {
        throw badArgs('scan 的文本必须是字符串');
      }
      return runFull(machine, text, maxMatches);
    },
    scanner() {
      return createScannerState(machine, maxMatches);
    },
  };
}

export function scan(patterns, text, options = {}) {
  validateOptions(options);
  if (typeof text !== 'string') {
    throw badArgs('scan 的文本必须是字符串');
  }
  return createMatcher(patterns, options).scan(text);
}

export function createScanner(patterns, options = {}) {
  validateOptions(options);
  const machine = compile(patterns, options.ignoreCase ?? false);
  const maxMatches = options.maxMatches ?? Number.POSITIVE_INFINITY;
  return createScannerState(machine, maxMatches);
}
