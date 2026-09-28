// 路径忽略规则。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/match.test.js、test/walk.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import { IgnoreError } from './errors.js';

export const DEFAULTS = {
  caseSensitive: true,
};

const DOUBLE_STAR = { doubleStar: true };

export function createIgnore(config) {
  if (!isObject(config)) {
    throw badArgs('createIgnore 的配置必须是对象');
  }
  if (!isStringArray(config.lines)) {
    throw badArgs('lines 必须是字符串数组');
  }

  let caseSensitive = DEFAULTS.caseSensitive;
  if (config.caseSensitive !== undefined) {
    if (typeof config.caseSensitive !== 'boolean') {
      throw badArgs('caseSensitive 必须是布尔值');
    }
    caseSensitive = config.caseSensitive;
  }

  const rules = [];
  config.lines.forEach((source, index) => {
    const rule = parseRule(source, index, caseSensitive);
    if (rule) {
      rules.push(rule);
    }
  });

  function directRule(pathSegments, isDir) {
    let matched = null;
    for (const rule of rules) {
      if (matchesRule(rule, pathSegments, isDir)) {
        matched = rule;
      }
    }
    return matched;
  }

  function testPath(path, options) {
    validatePath(path);
    const opts = options === undefined ? {} : options;
    if (!isObject(opts)) {
      throw badArgs('test 的第二个参数必须是对象');
    }

    let isDir = false;
    if (opts.isDir !== undefined) {
      if (typeof opts.isDir !== 'boolean') {
        throw badArgs('isDir 必须是布尔值');
      }
      isDir = opts.isDir;
    }

    const sourceSegments = path.split('/');
    const compareSegments = caseSensitive
      ? sourceSegments
      : sourceSegments.map((segment) => segment.toLowerCase());

    let blockedBy = null;
    for (let length = 1; length < sourceSegments.length; length += 1) {
      const ancestorRule = directRule(compareSegments.slice(0, length), true);
      if (ancestorRule !== null && !ancestorRule.negated) {
        blockedBy = sourceSegments.slice(0, length).join('/');
        break;
      }
    }

    if (blockedBy !== null) {
      return { ignored: true, rule: null, blockedBy };
    }

    const rule = directRule(compareSegments, isDir);
    if (rule === null) {
      return { ignored: false, rule: null, blockedBy: null };
    }
    return {
      ignored: !rule.negated,
      rule: rule.index,
      blockedBy: null,
    };
  }

  return {
    test: testPath,

    partition(entries) {
      if (!Array.isArray(entries)) {
        throw badArgs('partition 的入参必须是数组');
      }

      const kept = [];
      const ignored = [];
      for (const entry of entries) {
        if (!isObject(entry)) {
          throw badArgs('partition 的每个条目必须是对象');
        }
        const result = testPath(entry.path, {
          isDir: entry.isDir === undefined ? false : entry.isDir,
        });
        (result.ignored ? ignored : kept).push(entry);
      }
      return { kept, ignored };
    },

    rules() {
      return rules.map(({ index, source, pattern, negated, dirOnly, anchored }) => ({
        index,
        source,
        pattern,
        negated,
        dirOnly,
        anchored,
      }));
    },
  };
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value) {
  if (!Array.isArray(value)) {
    return false;
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      return false;
    }
  }
  return true;
}

function badArgs(message) {
  return new IgnoreError('ERR_BAD_ARGS', message);
}

function badRule(index, source) {
  return new IgnoreError('ERR_BAD_RULE', `第 ${index + 1} 行规则不合法`, { index, source });
}

function parseRule(source, index, caseSensitive) {
  const fail = () => {
    throw badRule(index, source);
  };
  const normalizeChar = caseSensitive
    ? (char) => char
    : (char) => char.toLowerCase();

  let body = source.endsWith('\r') ? source.slice(0, -1) : source;
  body = stripTrailingWhitespace(body);
  const effectiveSource = body;

  if (body === '' || body[0] === '#') {
    return null;
  }

  let negated = false;
  if (body[0] === '!') {
    negated = true;
    body = body.slice(1);
  }
  if (body === '') {
    throw badRule(index, source);
  }

  let dirOnly = false;
  if (body[body.length - 1] === '/' && !isEscapedAt(body, body.length - 1)) {
    dirOnly = true;
    body = body.slice(0, -1);
  }

  const anchored = hasAnchoringSlash(body, dirOnly);
  if (body[0] === '/') {
    body = body.slice(1);
  }
  if (body === '') {
    throw badRule(index, source);
  }

  const rawSegments = splitSegments(body, fail);
  if (rawSegments.some((segment) => segment === '')) {
    fail();
  }

  const segments = rawSegments.map((segment) =>
    compileSegment(segment, fail, normalizeChar),
  );

  return {
    index,
    source: effectiveSource,
    pattern: body,
    negated,
    dirOnly,
    anchored,
    segments,
  };
}

function stripTrailingWhitespace(value) {
  let end = value.length;
  while (end > 0 && (value[end - 1] === ' ' || value[end - 1] === '\t')) {
    if (isEscapedAt(value, end - 1)) {
      break;
    }
    end -= 1;
  }
  return value.slice(0, end);
}

function isEscapedAt(value, index) {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function hasAnchoringSlash(body, dirOnly) {
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '/' && !isEscapedAt(body, i)) {
      if (!(dirOnly && i === body.length - 1)) {
        return true;
      }
    }
  }
  return false;
}

function splitSegments(pattern, fail) {
  const segments = [];
  let start = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === '\\') {
      if (i + 1 >= pattern.length) {
        fail();
      }
      i += 1;
    } else if (pattern[i] === '/' && !isEscapedAt(pattern, i)) {
      segments.push(pattern.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(pattern.slice(start));
  return segments;
}

function compileSegment(segment, fail, normalizeChar) {
  if (segment === '**') {
    return DOUBLE_STAR;
  }

  const tokens = [];
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    if (char === '\\') {
      if (i + 1 >= segment.length) {
        fail();
      }
      tokens.push({ type: 'literal', value: normalizeChar(segment[i + 1]) });
      i += 1;
    } else if (char === '*') {
      if (segment[i + 1] === '*') {
        fail();
      }
      tokens.push({ type: 'star' });
    } else if (char === '?') {
      tokens.push({ type: 'question' });
    } else if (char === '[') {
      const parsed = parseCharacterClass(segment, i, fail, normalizeChar);
      tokens.push(parsed.token);
      i = parsed.next - 1;
    } else {
      tokens.push({ type: 'literal', value: normalizeChar(char) });
    }
  }

  return { tokens };
}

function parseCharacterClass(segment, start, fail, normalizeChar) {
  let i = start + 1;
  let negated = false;
  if (segment[i] === '!' || segment[i] === '^') {
    negated = true;
    i += 1;
  }

  const members = [];
  let first = true;
  let closed = false;

  while (i < segment.length) {
    if (segment[i] === ']' && !first) {
      i += 1;
      closed = true;
      break;
    }

    const low = readClassCharacter(segment, i, fail, normalizeChar);
    i = low.next;
    first = false;

    if (segment[i] === '-' && i + 1 < segment.length && segment[i + 1] !== ']') {
      i += 1;
      const high = readClassCharacter(segment, i, fail, normalizeChar);
      i = high.next;
      members.push({ type: 'range', low: low.value, high: high.value });
    } else {
      members.push({ type: 'char', value: low.value });
    }
  }

  if (!closed || members.length === 0) {
    fail();
  }

  return {
    token: { type: 'class', negated, members },
    next: i,
  };
}

function readClassCharacter(segment, index, fail, normalizeChar) {
  if (segment[index] === '\\') {
    if (index + 1 >= segment.length) {
      fail();
    }
    return { value: normalizeChar(segment[index + 1]), next: index + 2 };
  }
  return { value: normalizeChar(segment[index]), next: index + 1 };
}

function matchesRule(rule, pathSegments, isDir) {
  if (rule.dirOnly && !isDir) {
    return false;
  }

  const patternSegments = rule.anchored
    ? rule.segments
    : [DOUBLE_STAR, ...rule.segments];
  return matchesSegments(patternSegments, pathSegments, 0, 0);
}

function matchesSegments(patternSegments, pathSegments, patternIndex, pathIndex) {
  if (patternIndex === patternSegments.length) {
    return pathIndex === pathSegments.length;
  }

  const pattern = patternSegments[patternIndex];
  if (pattern.doubleStar) {
    if (patternIndex === patternSegments.length - 1) {
      return pathIndex < pathSegments.length;
    }
    for (let next = pathIndex; next <= pathSegments.length; next += 1) {
      if (matchesSegments(patternSegments, pathSegments, patternIndex + 1, next)) {
        return true;
      }
    }
    return false;
  }

  return (
    pathIndex < pathSegments.length &&
    matchesTokenSequence(pattern.tokens, pathSegments[pathIndex]) &&
    matchesSegments(patternSegments, pathSegments, patternIndex + 1, pathIndex + 1)
  );
}

function matchesTokenSequence(tokens, value) {
  let positions = new Set([0]);

  for (const token of tokens) {
    const nextPositions = new Set();
    for (const position of positions) {
      if (token.type === 'literal') {
        if (position < value.length && value[position] === token.value) {
          nextPositions.add(position + 1);
        }
      } else if (token.type === 'question') {
        if (position < value.length) {
          nextPositions.add(position + 1);
        }
      } else if (token.type === 'star') {
        for (let next = position; next <= value.length; next += 1) {
          nextPositions.add(next);
        }
      } else if (position < value.length && classMatches(token, value[position])) {
        nextPositions.add(position + 1);
      }
    }
    positions = nextPositions;
  }

  return positions.has(value.length);
}

function classMatches(token, char) {
  let included = false;
  for (const member of token.members) {
    if (member.type === 'char') {
      included ||= member.value === char;
    } else {
      included ||= char >= member.low && char <= member.high;
    }
  }
  return token.negated ? !included : included;
}

function validatePath(path) {
  if (
    typeof path !== 'string' ||
    path === '' ||
    path[0] === '/' ||
    path.endsWith('/') ||
    path.includes('\\')
  ) {
    throw new IgnoreError('ERR_BAD_PATH', '路径必须是相对根的 POSIX 路径');
  }

  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new IgnoreError('ERR_BAD_PATH', '路径不能包含空段、. 或 ..');
  }
}
