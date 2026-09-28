// 路径忽略规则。
//
// 口径见 README 的《口径》和《API》两节：锚定与浮动、`*`/`?`/`**` 的宽度、
// 最后一条命中、父目录剪枝（blockedBy 报最外面那一层）。

import { IgnoreError } from './errors.js';

export const DEFAULTS = {
  caseSensitive: true,
};

const DOUBLE_STAR = '**';

const badArgs = (message, details = {}) => new IgnoreError('ERR_BAD_ARGS', message, details);
const badRule = (message, details = {}) => new IgnoreError('ERR_BAD_RULE', message, details);
const badPath = (message, details = {}) => new IgnoreError('ERR_BAD_PATH', message, details);

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// 行尾未转义的空格和制表符不算；写 `\ ` 才是真的空格。行首空格不动。
const stripTrailingBlanks = (line) => {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) {
    let backslashes = 0;
    let cursor = end - 2;
    while (cursor >= 0 && line[cursor] === '\\') {
      backslashes += 1;
      cursor -= 1;
    }
    if (backslashes % 2 === 1) break;
    end -= 1;
  }
  return line.slice(0, end);
};

const endsWithUnescaped = (text, ch) => {
  if (!text.endsWith(ch)) return false;
  let backslashes = 0;
  let cursor = text.length - 2;
  while (cursor >= 0 && text[cursor] === '\\') {
    backslashes += 1;
    cursor -= 1;
  }
  return backslashes % 2 === 0;
};

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const escapeRegex = (text) => text.replace(REGEX_SPECIALS, '\\$&');

const escapeClassChar = (ch) => {
  if (ch === '\\') return '\\\\';
  if (ch === ']') return '\\]';
  if (ch === '^') return '\\^';
  return ch;
};

// 把一个路径段（不是 `**`）编译成整段匹配的正则。
const compileSegment = (segment, index, source) => {
  let out = '';
  let cursor = 0;
  while (cursor < segment.length) {
    const ch = segment[cursor];
    if (ch === '\\') {
      if (cursor + 1 < segment.length) {
        out += escapeRegex(segment[cursor + 1]);
        cursor += 2;
      } else {
        out += '\\\\';
        cursor += 1;
      }
    } else if (ch === '*') {
      out += '.*';
      cursor += 1;
    } else if (ch === '?') {
      out += '.';
      cursor += 1;
    } else if (ch === '[') {
      let scan = cursor + 1;
      let negated = false;
      if (segment[scan] === '!' || segment[scan] === '^') {
        negated = true;
        scan += 1;
      }
      let content = '';
      let closed = false;
      while (scan < segment.length) {
        const inner = segment[scan];
        if (inner === '\\' && scan + 1 < segment.length) {
          content += escapeClassChar(segment[scan + 1]);
          scan += 2;
        } else if (inner === ']') {
          closed = true;
          scan += 1;
          break;
        } else {
          content += escapeClassChar(inner);
          scan += 1;
        }
      }
      if (!closed) {
        throw badRule('字符类没有配对的 ]', { index, source });
      }
      if (content === '') {
        throw badRule('字符类是空的', { index, source });
      }
      out += `[${negated ? '^' : ''}${content}]`;
      cursor = scan;
    } else {
      out += escapeRegex(ch);
      cursor += 1;
    }
  }
  return new RegExp(`^${out}$`);
};

// 解析一行规则；注释和空行返回 null（但它们照样占行号）。
const parseRule = (rawLine, index, caseSensitive) => {
  const withoutCr = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  const line = stripTrailingBlanks(withoutCr);
  if (line === '' || line.startsWith('#')) return null;

  let pattern = line;
  let negated = false;
  if (pattern.startsWith('!')) {
    negated = true;
    pattern = pattern.slice(1);
    if (pattern === '') {
      throw badRule('取反规则只剩一个 !', { index, source: line });
    }
  }

  let dirOnly = false;
  if (endsWithUnescaped(pattern, '/')) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }

  const anchored = pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);

  const segments = pattern.split('/');
  if (segments.some((segment) => segment === '')) {
    throw badRule('规则里有空的路径段', { index, source: line });
  }
  for (const segment of segments) {
    if (segment !== DOUBLE_STAR && segment.includes(DOUBLE_STAR)) {
      throw badRule('** 只能自己占一整段', { index, source: line });
    }
  }

  const folded = caseSensitive ? segments : segments.map((segment) => segment.toLowerCase());
  const testers = folded.map((segment) =>
    segment === DOUBLE_STAR ? null : compileSegment(segment, index, line));

  return { index, source: line, pattern, negated, dirOnly, anchored, segments: folded, testers };
};

// 锚定规则的段对段匹配：中间的 `**` 允许零层，结尾的 `**` 至少吃一层。
const matchFrom = (rule, ruleAt, pathAt, pathSegments) => {
  const { segments, testers } = rule;
  if (ruleAt === segments.length) return pathAt === pathSegments.length;
  if (segments[ruleAt] === DOUBLE_STAR) {
    const atEnd = ruleAt === segments.length - 1;
    const minConsume = atEnd ? 1 : 0;
    for (let take = minConsume; pathAt + take <= pathSegments.length; take += 1) {
      if (matchFrom(rule, ruleAt + 1, pathAt + take, pathSegments)) return true;
    }
    return false;
  }
  if (pathAt >= pathSegments.length) return false;
  if (!testers[ruleAt].test(pathSegments[pathAt])) return false;
  return matchFrom(rule, ruleAt + 1, pathAt + 1, pathSegments);
};

const matchRule = (rule, pathSegments, isDir) => {
  if (rule.dirOnly && !isDir) return false;
  if (!rule.anchored) {
    // 浮动规则没有斜杠，永远只有一段，等价于前面补一个 `**/`。
    const tester = rule.testers[rule.testers.length - 1];
    if (tester === null) return true;
    return tester.test(pathSegments[pathSegments.length - 1]);
  }
  return matchFrom(rule, 0, 0, pathSegments);
};

const checkPath = (path) => {
  if (typeof path !== 'string' || path === '') {
    throw badPath('路径必须是非空字符串');
  }
  if (path.startsWith('/')) throw badPath('路径不能带前导 /');
  if (path.includes('\\')) throw badPath('路径不能带反斜杠');
  if (path.endsWith('/')) throw badPath('路径不能带结尾 /');
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw badPath('路径里有空的或者 . / .. 段');
  }
  return segments;
};

export function createIgnore(config) {
  if (!isPlainObject(config)) {
    throw badArgs('createIgnore 需要一个配置对象');
  }
  const { lines, caseSensitive = DEFAULTS.caseSensitive } = config;
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== 'string')) {
    throw badArgs('lines 必须是字符串数组');
  }
  if (typeof caseSensitive !== 'boolean') {
    throw badArgs('caseSensitive 必须是布尔值');
  }

  const parsed = [];
  lines.forEach((line, index) => {
    const rule = parseRule(line, index, caseSensitive);
    if (rule !== null) parsed.push(rule);
  });

  // 最后一条命中的规则说了算；取反命中就是不忽略。
  const evaluate = (pathSegments, isDir) => {
    let matched = null;
    for (const rule of parsed) {
      if (matchRule(rule, pathSegments, isDir)) matched = rule;
    }
    if (matched === null) return { ignored: false, rule: null };
    return { ignored: !matched.negated, rule: matched.index };
  };

  const test = (path, options = {}) => {
    if (!isPlainObject(options)) {
      throw badArgs('test 的第二个参数必须是对象');
    }
    const { isDir = false } = options;
    if (typeof isDir !== 'boolean') {
      throw badArgs('isDir 必须是布尔值');
    }
    const segments = checkPath(path);
    const folded = caseSensitive ? segments : segments.map((segment) => segment.toLowerCase());

    // 父目录剪枝：任何一层祖先被判忽略，里面的路径就直接忽略，
    // 取反规则救不回来；blockedBy 报最外面那一层。祖先自己被后面的
    // 取反规则救回时 evaluate 会判它不忽略，自然不算被剪。
    for (let depth = 1; depth < folded.length; depth += 1) {
      if (evaluate(folded.slice(0, depth), true).ignored) {
        return { ignored: true, rule: null, blockedBy: segments.slice(0, depth).join('/') };
      }
    }
    const verdict = evaluate(folded, isDir);
    return { ignored: verdict.ignored, rule: verdict.rule, blockedBy: null };
  };

  const partition = (entries) => {
    if (!Array.isArray(entries)) {
      throw badArgs('partition 的入参必须是数组');
    }
    const kept = [];
    const ignored = [];
    for (const entry of entries) {
      if (!isPlainObject(entry)) {
        throw badArgs('partition 的条目必须是对象');
      }
      const verdict = test(entry.path, { isDir: entry.isDir === undefined ? false : entry.isDir });
      (verdict.ignored ? ignored : kept).push(entry);
    }
    return { kept, ignored };
  };

  const rules = () =>
    parsed.map(({ index, source, pattern, negated, dirOnly, anchored }) =>
      ({ index, source, pattern, negated, dirOnly, anchored }));

  return { test, partition, rules };
}
