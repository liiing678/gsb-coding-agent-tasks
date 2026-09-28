// 多模式匹配（Aho–Corasick）与流式扫描。
//
// 口径见 README：位置按码点数；同一结束位置按长度降序、再按模式表先后；
// ignoreCase 逐码点折 lowercase，折完码点数会变的字符不折；maxMatches 超出的
// 悄悄丢掉并把 truncated 置 true；流式扫描跨块攒着，半个代理对先压着。

import { MatchgridError } from './errors.js';

const fail = (code, message, details = {}) => {
  throw new MatchgridError(code, message, details);
};

// 逐码点折 lowercase；折完码点数会变的（如 İ）当它没折，保住位置对齐。
const foldChar = (ch) => {
  const folded = ch.toLowerCase();
  return [...folded].length === 1 ? folded : ch;
};

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;

function parseOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('ERR_BAD_ARGS', 'options 得是对象', { options });
  }
  const { ignoreCase = false, maxMatches } = options;
  if (typeof ignoreCase !== 'boolean') {
    fail('ERR_BAD_ARGS', 'ignoreCase 得是布尔值', { ignoreCase });
  }
  if (maxMatches !== undefined && (!Number.isInteger(maxMatches) || maxMatches <= 0)) {
    fail('ERR_BAD_ARGS', 'maxMatches 得是正整数', { maxMatches });
  }
  return { ignoreCase, maxMatches };
}

function preparePatterns(patterns, ignoreCase) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    fail('ERR_BAD_PATTERNS', 'patterns 得是非空数组', { patterns });
  }
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      fail('ERR_BAD_PATTERNS', '每条模式都得是非空字符串', { pattern });
    }
  }
  const folded = patterns.map((p) => (ignoreCase ? [...p].map(foldChar).join('') : p));
  const seen = new Set();
  for (const f of folded) {
    if (seen.has(f)) {
      fail('ERR_BAD_PATTERNS', '模式（折叠后）重样', { pattern: f });
    }
    seen.add(f);
  }
  return folded;
}

function buildAutomaton(folded) {
  const lengths = folded.map((p) => [...p].length);
  const byLengthDesc = (a, b) => lengths[b] - lengths[a];
  const newNode = (depth) => ({ next: new Map(), fail: null, depth, terminal: [], outputs: [] });
  const root = newNode(0);
  root.fail = root;

  folded.forEach((pattern, idx) => {
    let node = root;
    for (const ch of pattern) {
      if (!node.next.has(ch)) node.next.set(ch, newNode(node.depth + 1));
      node = node.next.get(ch);
    }
    node.terminal.push(idx);
  });

  // BFS 建失败链；失败链总指向更浅的状态，所以 outputs 可以顺手算出来。
  const queue = [];
  for (const child of root.next.values()) {
    child.fail = root;
    child.outputs = [...child.terminal].sort(byLengthDesc);
    queue.push(child);
  }
  while (queue.length > 0) {
    const node = queue.shift();
    for (const [ch, child] of node.next) {
      let f = node.fail;
      while (f !== root && !f.next.has(ch)) f = f.fail;
      child.fail = f.next.has(ch) ? f.next.get(ch) : root;
      child.outputs = [...child.terminal, ...child.fail.outputs].sort(byLengthDesc);
      queue.push(child);
    }
  }
  return { root, lengths };
}

// 匹配引擎：逐码点喂入，按结束位置升序、同处长度降序报匹配。
function createEngine(meta) {
  const { root, lengths, originals, ignoreCase, maxMatches } = meta;
  const limit = maxMatches ?? Infinity;
  let node = root;
  let fed = 0;
  let truncated = false;
  const all = [];
  let recent = [];

  const feed = (rawCh) => {
    const ch = ignoreCase ? foldChar(rawCh) : rawCh;
    while (node !== root && !node.next.has(ch)) node = node.fail;
    node = node.next.get(ch) ?? root;
    const end = fed + 1;
    fed += 1;
    for (const idx of node.outputs) {
      if (all.length < limit) {
        const match = { pattern: originals[idx], index: end - lengths[idx], length: lengths[idx] };
        all.push(match);
        recent.push(match);
      } else {
        truncated = true;
      }
    }
  };

  // 还悬着的尾巴：从当前状态顺失败链往上，第一个还有出边的状态（根不算）的深度。
  const pending = () => {
    let n = node;
    while (n !== root) {
      if (n.next.size > 0) return n.depth;
      n = n.fail;
    }
    return 0;
  };

  return {
    feed,
    pending,
    beginPush: () => {
      recent = [];
    },
    takeRecent: () => recent,
    all: () => all.slice(),
    get fed() {
      return fed;
    },
    get total() {
      return all.length;
    },
    get truncated() {
      return truncated;
    },
  };
}

function buildMeta(patterns, options) {
  const { ignoreCase, maxMatches } = parseOptions(options);
  const folded = preparePatterns(patterns, ignoreCase);
  const { root, lengths } = buildAutomaton(folded);
  return { root, lengths, originals: [...patterns], ignoreCase, maxMatches };
}

function makeScanner(meta) {
  const engine = createEngine(meta);
  let held = '';
  let closed = false;

  const push = (chunk) => {
    if (closed) fail('ERR_STREAM_CLOSED', '流已封口，不能再 push');
    if (typeof chunk !== 'string') fail('ERR_BAD_ARGS', 'push 的块得是字符串', { chunk });
    let text = held + chunk;
    held = '';
    // 块尾是半个代理对就先压着，等下一块补齐再喂。
    if (text.length > 0 && isHighSurrogate(text.charCodeAt(text.length - 1))) {
      held = text[text.length - 1];
      text = text.slice(0, -1);
    }
    engine.beginPush();
    for (const ch of text) engine.feed(ch);
    return engine.takeRecent();
  };

  const state = () => ({
    fed: engine.fed,
    pending: engine.pending(),
    total: engine.total,
    truncated: engine.truncated,
    closed,
  });

  const end = () => {
    closed = true;
    return state();
  };

  return { push, end, all: () => engine.all(), state };
}

export function createMatcher(patterns, options = {}) {
  const meta = buildMeta(patterns, options);
  return {
    get patterns() {
      return [...meta.originals];
    },
    scan(text) {
      if (typeof text !== 'string') fail('ERR_BAD_ARGS', 'scan 的文本得是字符串', { text });
      const engine = createEngine(meta);
      for (const ch of text) engine.feed(ch);
      return { matches: engine.all(), truncated: engine.truncated };
    },
    scanner() {
      return makeScanner(meta);
    },
  };
}

export function scan(patterns, text, options = {}) {
  return createMatcher(patterns, options).scan(text);
}

export function createScanner(patterns, options = {}) {
  return makeScanner(buildMeta(patterns, options));
}
