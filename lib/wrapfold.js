// 折行与截断：码点宽度、字素簇断点与禁则修正。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/width.test.js、test/wrap.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import { WrapfoldError } from './errors.js';

export const DEFAULTS = {
  width: 20,
  breakLongWords: false,
};

const bad = (message, details = {}) => new WrapfoldError('ERR_BAD_ARGS', message, details);

// 宽度表：0 宽（组合记号、零宽）、2 宽（汉字、全角、emoji 等），其余 1 宽。
const ZERO_RANGES = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x20d0, 0x20ff],
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
];

const DOUBLE_RANGES = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

const inRanges = (ranges, cp) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

function codePointWidth(cp) {
  if (cp === 0x0d) return 0; // \r 本身不算宽度
  if (inRanges(ZERO_RANGES, cp)) return 0;
  if (inRanges(DOUBLE_RANGES, cp)) return 2;
  return 1;
}

export function displayWidth(text) {
  if (typeof text !== 'string') {
    throw bad('displayWidth: text 必须是字符串', { text });
  }
  let total = 0;
  for (const ch of text) {
    total += codePointWidth(ch.codePointAt(0));
  }
  return total;
}

// 禁则字符：行尾不能有开括号类，行首不能有收尾标点类。
const toCodePoints = (chars) => new Set([...chars].map((ch) => ch.codePointAt(0)));
const LINE_END_FORBIDDEN = toCodePoints('([{<（「『【《〈');
const LINE_START_FORBIDDEN = toCodePoints(',.;:!?)]}>%，。、；：！？）」』】》〉％');

const SPACE = 0x20;
const HYPHEN = 0x2d;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function segmentClusters(text) {
  const clusters = [];
  for (const { segment } of segmenter.segment(text)) {
    let width = 0;
    let first;
    let firstWidth = 0;
    let last = 0;
    let lastWidth = 0;
    for (const ch of segment) {
      const cp = ch.codePointAt(0);
      const w = codePointWidth(cp);
      if (first === undefined) {
        first = cp;
        firstWidth = w;
      }
      last = cp;
      lastWidth = w;
      width += w;
    }
    clusters.push({ text: segment, width, first, firstWidth, last, lastWidth });
  }
  return clusters;
}

// 断点只认三种：空格之后、连字符之后、两个 2 宽字符之间。
function isBreak(clusters, p) {
  const left = clusters[p - 1];
  const right = clusters[p];
  if (left.last === SPACE) return true;
  if (left.last === HYPHEN) return true;
  return left.lastWidth === 2 && right.firstWidth === 2;
}

// 行尾的空格一律吃掉：返回去掉尾部空格簇之后的结束下标。
function stripTrailingSpaces(clusters, start, end) {
  while (end > start && clusters[end - 1].last === SPACE) end -= 1;
  return end;
}

function joinClusters(clusters, start, end) {
  let out = '';
  for (let i = start; i < end; i += 1) out += clusters[i].text;
  return out;
}

// 禁则修正：先往左收（至少留一个簇），再往右推（行首禁则字符带上，允许超宽）。
function applyForbidden(clusters, start, p, n) {
  if (p - 1 > start && LINE_END_FORBIDDEN.has(clusters[p - 1].last)) {
    p -= 1;
  }
  while (p < n && LINE_START_FORBIDDEN.has(clusters[p].first)) {
    p += 1;
  }
  return p;
}

function wrapParagraph(paragraph, indent, hangingIndent, width, breakLongWords, lines) {
  const clusters = segmentClusters(paragraph);
  const n = clusters.length;
  if (n === 0) {
    lines.push({ text: indent, width: displayWidth(indent) });
    return;
  }
  const sums = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i += 1) sums[i + 1] = sums[i] + clusters[i].width;

  let prefix = indent;
  let start = 0;
  while (start < n) {
    const available = width - displayWidth(prefix);
    const push = (end) => {
      const text = prefix + joinClusters(clusters, start, stripTrailingSpaces(clusters, start, end));
      lines.push({ text, width: displayWidth(text) });
    };

    if (sums[n] - sums[start] <= available) {
      push(n); // 剩下的全装得下
      break;
    }

    // 从右往左找最近的、装得下的断点
    let p = -1;
    for (let q = n - 1; q > start; q -= 1) {
      if (!isBreak(clusters, q)) continue;
      const end = stripTrailingSpaces(clusters, start, q);
      if (sums[end] - sums[start] <= available) {
        p = q;
        break;
      }
    }

    if (p !== -1) {
      p = applyForbidden(clusters, start, p, n);
      push(p);
      start = p;
    } else if (!breakLongWords) {
      // 断不了的整块自己占一行，超宽就超宽
      let end = start + 1;
      while (end < n && !isBreak(clusters, end)) end += 1;
      push(end);
      start = end;
    } else {
      // 按字素簇硬断，能塞几个塞几个（至少一个）
      let count = 0;
      while (start + count < n && sums[start + count + 1] - sums[start] <= available) {
        count += 1;
      }
      p = applyForbidden(clusters, start, start + Math.max(count, 1), n);
      push(p);
      start = p;
    }
    prefix = hangingIndent;
  }
}

export function wrap(text, options = {}) {
  if (typeof text !== 'string') {
    throw bad('wrap: text 必须是字符串', { text });
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw bad('wrap: options 必须是对象', { options });
  }
  const {
    width = DEFAULTS.width,
    indent = '',
    hangingIndent = indent,
    breakLongWords = DEFAULTS.breakLongWords,
  } = options;
  if (!Number.isInteger(width) || width <= 0) {
    throw bad('wrap: width 必须是正整数', { width });
  }
  if (typeof indent !== 'string') {
    throw bad('wrap: indent 必须是字符串', { indent });
  }
  if (typeof hangingIndent !== 'string') {
    throw bad('wrap: hangingIndent 必须是字符串', { hangingIndent });
  }
  if (typeof breakLongWords !== 'boolean') {
    throw bad('wrap: breakLongWords 必须是布尔值', { breakLongWords });
  }
  if (displayWidth(indent) >= width) {
    throw bad('wrap: indent 的宽度必须小于 width', { indent, width });
  }
  if (displayWidth(hangingIndent) >= width) {
    throw bad('wrap: hangingIndent 的宽度必须小于 width', { hangingIndent, width });
  }

  const lines = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    wrapParagraph(paragraph, indent, hangingIndent, width, breakLongWords, lines);
  }
  const overflow = lines.reduce((count, line) => count + (line.width > width ? 1 : 0), 0);
  return { lines, overflow };
}

export function clip(text, width, ellipsis = '…') {
  if (typeof text !== 'string') {
    throw bad('clip: text 必须是字符串', { text });
  }
  if (!Number.isInteger(width) || width <= 0) {
    throw bad('clip: width 必须是正整数', { width });
  }
  if (typeof ellipsis !== 'string') {
    throw bad('clip: ellipsis 必须是字符串', { ellipsis });
  }
  const total = displayWidth(text);
  if (total <= width) {
    return { text, width: total, clipped: false };
  }
  const ellipsisWidth = displayWidth(ellipsis);
  if (ellipsisWidth > width) {
    return { text: '', width: 0, clipped: true };
  }
  const clusters = segmentClusters(text);
  let keep = clusters.length;
  let kept = total;
  while (keep > 0 && kept + ellipsisWidth > width) {
    keep -= 1;
    kept -= clusters[keep].width;
  }
  const out = joinClusters(clusters, 0, keep) + ellipsis;
  return { text: out, width: kept + ellipsisWidth, clipped: true };
}
