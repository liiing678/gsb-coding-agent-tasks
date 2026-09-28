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

const ZERO_WIDTH_RANGES = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x20d0, 0x20ff],
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
];

const DOUBLE_WIDTH_RANGES = [
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

// 行尾禁则（开括号类，不能留在上一行行尾）与行首禁则（收尾标点，不能掉到下一行行首）。
const LINE_END_FORBIDDEN = new Set('([{<（「『【《〈');
const LINE_START_FORBIDDEN = new Set(',.;:!?)]}>%，。、；：！？）」』】》〉％');

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const badArgs = (message, details = {}) => new WrapfoldError('ERR_BAD_ARGS', message, details);

const inRanges = (ranges, cp) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

export function displayWidth(text) {
  if (typeof text !== 'string') {
    throw badArgs('displayWidth: text 必须是字符串', { text });
  }
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (inRanges(ZERO_WIDTH_RANGES, cp)) continue;
    width += inRanges(DOUBLE_WIDTH_RANGES, cp) ? 2 : 1;
  }
  return width;
}

const graphemesOf = (text) => {
  const clusters = [];
  for (const item of graphemeSegmenter.segment(text)) {
    clusters.push(item.segment);
  }
  return clusters;
};

// 把一段（已经按换行切好）折进行数组 lines。断点三种：空格后（空格吃掉）、
// 连字符后（连字符留在上一行）、两个 2 宽字符之间。禁则修正先往左收、再往右推。
function wrapParagraph(clusters, options, lines) {
  const { width, indent, hangingIndent, indentWidth, hangingWidth, breakLongWords } = options;
  const n = clusters.length;
  if (n === 0) {
    lines.push({ text: indent, width: indentWidth });
    return;
  }
  const widths = clusters.map((cluster) => displayWidth(cluster));
  const prefix = new Array(n + 1);
  prefix[0] = 0;
  for (let i = 0; i < n; i++) {
    prefix[i + 1] = prefix[i] + widths[i];
  }

  const isBreakBefore = (k) =>
    clusters[k - 1] === ' ' ||
    clusters[k - 1] === '-' ||
    (widths[k - 1] === 2 && k < n && widths[k] === 2);

  let start = 0;
  let firstLine = true;

  const emit = (lineEnd, next) => {
    let end = lineEnd;
    while (end > start && clusters[end - 1] === ' ') {
      end--;
    }
    const currentIndent = firstLine ? indent : hangingIndent;
    const currentIndentWidth = firstLine ? indentWidth : hangingWidth;
    lines.push({
      text: currentIndent + clusters.slice(start, end).join(''),
      width: currentIndentWidth + prefix[end] - prefix[start],
    });
    start = next;
    firstLine = false;
  };

  while (start < n) {
    const limit = width - (firstLine ? indentWidth : hangingWidth);
    let fit = start;
    while (fit < n && prefix[fit + 1] - prefix[start] <= limit) {
      fit++;
    }
    if (fit === n) {
      emit(n, n);
      break;
    }

    let lineEnd = -1;
    let next = -1;
    for (let k = Math.min(fit + 1, n); k > start; k--) {
      if (clusters[k - 1] === ' ') {
        if (k - 1 > start) {
          lineEnd = k - 1;
          next = k;
          break;
        }
        continue;
      }
      if (k > fit) {
        continue;
      }
      if (clusters[k - 1] === '-' || (widths[k - 1] === 2 && k < n && widths[k] === 2)) {
        lineEnd = k;
        next = k;
        break;
      }
    }

    if (lineEnd === -1) {
      if (breakLongWords) {
        lineEnd = Math.max(fit, start + 1);
        next = lineEnd;
      } else {
        let k = start + 1;
        while (k < n && !isBreakBefore(k)) {
          k++;
        }
        if (k === n) {
          emit(n, n);
        } else if (clusters[k - 1] === ' ') {
          emit(k - 1, k);
        } else {
          emit(k, k);
        }
        continue;
      }
    }

    if (lineEnd - 1 > start && LINE_END_FORBIDDEN.has(clusters[lineEnd - 1])) {
      lineEnd--;
      next = lineEnd;
    }
    while (next < n && LINE_START_FORBIDDEN.has(clusters[next])) {
      next++;
      lineEnd = next;
    }
    emit(lineEnd, next);
  }
}

export function wrap(text, options = {}) {
  if (typeof text !== 'string') {
    throw badArgs('wrap: text 必须是字符串', { text });
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw badArgs('wrap: options 必须是对象', { options });
  }
  const {
    width = DEFAULTS.width,
    indent = '',
    hangingIndent = indent,
    breakLongWords = DEFAULTS.breakLongWords,
  } = options;
  if (!Number.isInteger(width) || width <= 0) {
    throw badArgs('wrap: width 必须是正整数', { width });
  }
  if (typeof indent !== 'string') {
    throw badArgs('wrap: indent 必须是字符串', { indent });
  }
  if (typeof hangingIndent !== 'string') {
    throw badArgs('wrap: hangingIndent 必须是字符串', { hangingIndent });
  }
  if (typeof breakLongWords !== 'boolean') {
    throw badArgs('wrap: breakLongWords 必须是布尔值', { breakLongWords });
  }
  const indentWidth = displayWidth(indent);
  const hangingWidth = displayWidth(hangingIndent);
  if (indentWidth >= width) {
    throw badArgs('wrap: indent 的宽度必须小于 width', { indent, width });
  }
  if (hangingWidth >= width) {
    throw badArgs('wrap: hangingIndent 的宽度必须小于 width', { hangingIndent, width });
  }

  const lines = [];
  const shared = { width, indent, hangingIndent, indentWidth, hangingWidth, breakLongWords };
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    wrapParagraph(graphemesOf(paragraph), shared, lines);
  }
  let overflow = 0;
  for (const line of lines) {
    if (line.width > width) {
      overflow++;
    }
  }
  return { lines, overflow };
}

export function clip(text, width, ellipsis = '…') {
  if (typeof text !== 'string') {
    throw badArgs('clip: text 必须是字符串', { text });
  }
  if (!Number.isInteger(width) || width <= 0) {
    throw badArgs('clip: width 必须是正整数', { width });
  }
  if (typeof ellipsis !== 'string') {
    throw badArgs('clip: ellipsis 必须是字符串', { ellipsis });
  }
  const fullWidth = displayWidth(text);
  if (fullWidth <= width) {
    return { text, width: fullWidth, clipped: false };
  }
  const ellipsisWidth = displayWidth(ellipsis);
  if (ellipsisWidth > width) {
    return { text: '', width: 0, clipped: true };
  }
  const clusters = graphemesOf(text);
  let keep = clusters.length;
  let keepWidth = fullWidth;
  while (keep > 0 && keepWidth + ellipsisWidth > width) {
    keep--;
    keepWidth -= displayWidth(clusters[keep]);
  }
  return {
    text: clusters.slice(0, keep).join('') + ellipsis,
    width: keepWidth + ellipsisWidth,
    clipped: true,
  };
}
