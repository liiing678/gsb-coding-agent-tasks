// 行级三方合并。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/basic|conflict|policy）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）和切行工具（lib/lines.js）
// 都已经按 README 的《口径》和《API》两节写好了。那些约定不要改，把这里补出来。

import { MergeError } from './errors.js';
import { splitLines, joinLines, sameLines } from './lines.js';

export const DEFAULTS = {
  conflictStyle: 'markers', // markers | ours | theirs | union
  markerLayout: 'diff3',    // diff3 | merge
  oursLabel: 'ours',
  baseLabel: 'base',
  theirsLabel: 'theirs',
};

// 单边行数上限。
export const MAX_LINES = 20000;

const CONFLICT_STYLES = ['markers', 'ours', 'theirs', 'union'];
const MARKER_LAYOUTS = ['diff3', 'merge'];

const INPUT_FIELDS = ['base', 'ours', 'theirs'];

export function mergeThreeWay(base, ours, theirs, options = {}) {
  const values = { base, ours, theirs };
  for (const field of INPUT_FIELDS) {
    if (typeof values[field] !== 'string') {
      throw new MergeError('ERR_BAD_INPUT', `${field} 必须是字符串`, { field });
    }
  }

  const opts = {
    conflictStyle: options.conflictStyle ?? DEFAULTS.conflictStyle,
    markerLayout: options.markerLayout ?? DEFAULTS.markerLayout,
    oursLabel: options.oursLabel ?? DEFAULTS.oursLabel,
    baseLabel: options.baseLabel ?? DEFAULTS.baseLabel,
    theirsLabel: options.theirsLabel ?? DEFAULTS.theirsLabel,
  };
  if (!CONFLICT_STYLES.includes(opts.conflictStyle)) {
    throw new MergeError('ERR_BAD_OPTION', `不认识的 conflictStyle: ${opts.conflictStyle}`, {
      field: 'conflictStyle',
      value: opts.conflictStyle,
    });
  }
  if (!MARKER_LAYOUTS.includes(opts.markerLayout)) {
    throw new MergeError('ERR_BAD_OPTION', `不认识的 markerLayout: ${opts.markerLayout}`, {
      field: 'markerLayout',
      value: opts.markerLayout,
    });
  }
  if (opts.conflictStyle === 'markers') {
    for (const field of ['oursLabel', 'baseLabel', 'theirsLabel']) {
      if (typeof opts[field] !== 'string' || opts[field] === '') {
        throw new MergeError('ERR_BAD_OPTION', `${field} 必须是非空字符串`, { field });
      }
    }
  }

  const lines = {
    base: splitLines(base),
    ours: splitLines(ours),
    theirs: splitLines(theirs),
  };
  for (const field of INPUT_FIELDS) {
    if (lines[field].length > MAX_LINES) {
      throw new MergeError('ERR_TOO_MANY_LINES', `${field} 超过单边行数上限`, {
        field,
        lines: lines[field].length,
        max: MAX_LINES,
      });
    }
  }

  const baseLines = lines.base;
  const oursLines = lines.ours;
  const theirsLines = lines.theirs;

  // 两边各自相对 base 的改动区（hunk），再按 base 上的位置聚类成段：
  // 中间一行公共行都没有的改动并进同一段。
  const hunksOurs = diffLines(baseLines, oursLines);
  const hunksTheirs = diffLines(baseLines, theirsLines);
  const segments = clusterHunks(hunksOurs, hunksTheirs);
  const mapOurs = buildBoundaryMaps(baseLines.length, hunksOurs);
  const mapTheirs = buildBoundaryMaps(baseLines.length, hunksTheirs);

  const outLines = [];
  const conflicts = [];
  let cursor = 0;

  for (const segment of segments) {
    for (let i = cursor; i < segment.aStart; i++) outLines.push(baseLines[i]);
    cursor = segment.aEnd;

    const baseSlice = baseLines.slice(segment.aStart, segment.aEnd);
    const oursSlice = oursLines.slice(
      mapOurs.before[segment.aStart],
      mapOurs.after[segment.aEnd],
    );
    const theirsSlice = theirsLines.slice(
      mapTheirs.before[segment.aStart],
      mapTheirs.after[segment.aEnd],
    );

    if (sameLines(oursSlice, theirsSlice)) {
      outLines.push(...oursSlice);
      continue;
    }
    if (sameLines(oursSlice, baseSlice)) {
      outLines.push(...theirsSlice);
      continue;
    }
    if (sameLines(theirsSlice, baseSlice)) {
      outLines.push(...oursSlice);
      continue;
    }

    conflicts.push({
      index: conflicts.length + 1,
      outputLine: outLines.length + 1,
      oursCount: oursSlice.length,
      baseCount: baseSlice.length,
      theirsCount: theirsSlice.length,
    });

    if (opts.conflictStyle === 'ours') {
      outLines.push(...oursSlice);
    } else if (opts.conflictStyle === 'theirs') {
      outLines.push(...theirsSlice);
    } else if (opts.conflictStyle === 'union') {
      outLines.push(...oursSlice);
      const oursSet = new Set(oursSlice);
      for (const line of theirsSlice) {
        if (!oursSet.has(line)) outLines.push(line);
      }
    } else {
      outLines.push(`<<<<<<< ${opts.oursLabel}`);
      outLines.push(...oursSlice);
      if (opts.markerLayout === 'diff3') {
        outLines.push(`||||||| ${opts.baseLabel}`);
        outLines.push(...baseSlice);
      }
      outLines.push('=======');
      outLines.push(...theirsSlice);
      outLines.push(`>>>>>>> ${opts.theirsLabel}`);
    }
  }
  for (let i = cursor; i < baseLines.length; i++) outLines.push(baseLines[i]);

  // 最终文本相对 base 的行级差异：替换在 diff 里自然是一删一增。
  let addedLines = 0;
  let removedLines = 0;
  for (const hunk of diffLines(baseLines, outLines)) {
    removedLines += hunk.aEnd - hunk.aStart;
    addedLines += hunk.bEnd - hunk.bStart;
  }

  return {
    text: joinLines(outLines),
    clean: conflicts.length === 0,
    conflicts,
    stats: {
      segments: segments.length,
      conflicts: conflicts.length,
      addedLines,
      removedLines,
    },
  };
}

// 行级 diff：返回 a 相对 b 的改动区 [{aStart, aEnd, bStart, bEnd}]，
// 按 aStart 升序。先剥公共前后缀，再在中间找两侧都唯一的行当锚点
// （取 b 位置的最长递增子序列），锚点之间递归处理；没有锚点就把整块
// 算一个改动区。大部分相同的万行文件只会真正 diff 很小的中间区域。
function diffLines(a, b) {
  const hunks = [];
  const stack = [[0, a.length, 0, b.length]];
  while (stack.length > 0) {
    let [aLo, aHi, bLo, bHi] = stack.pop();
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
      aLo++;
      bLo++;
    }
    while (aHi > aLo && bHi > bLo && a[aHi - 1] === b[bHi - 1]) {
      aHi--;
      bHi--;
    }
    if (aLo === aHi || bLo === bHi) {
      if (aLo < aHi || bLo < bHi) {
        hunks.push({ aStart: aLo, aEnd: aHi, bStart: bLo, bEnd: bHi });
      }
      continue;
    }

    const countA = new Map();
    const posA = new Map();
    for (let i = aLo; i < aHi; i++) {
      countA.set(a[i], (countA.get(a[i]) || 0) + 1);
      posA.set(a[i], i);
    }
    const countB = new Map();
    const posB = new Map();
    for (let j = bLo; j < bHi; j++) {
      countB.set(b[j], (countB.get(b[j]) || 0) + 1);
      posB.set(b[j], j);
    }
    const pairs = [];
    for (const [line, count] of countA) {
      if (count === 1 && countB.get(line) === 1) {
        pairs.push([posA.get(line), posB.get(line)]);
      }
    }
    if (pairs.length === 0) {
      hunks.push({ aStart: aLo, aEnd: aHi, bStart: bLo, bEnd: bHi });
      continue;
    }

    pairs.sort((p, q) => p[0] - q[0]);
    const keep = lisIndices(pairs.map((pair) => pair[1]));
    const regions = [];
    let prevA = aLo;
    let prevB = bLo;
    for (const idx of keep) {
      regions.push([prevA, pairs[idx][0], prevB, pairs[idx][1]]);
      prevA = pairs[idx][0] + 1;
      prevB = pairs[idx][1] + 1;
    }
    regions.push([prevA, aHi, prevB, bHi]);
    for (const region of regions) stack.push(region);
  }
  hunks.sort((x, y) => x.aStart - y.aStart || x.aEnd - y.aEnd);
  return hunks;
}

// 最长严格递增子序列，返回的是 values 里的下标。
function lisIndices(values) {
  const tails = [];
  const prev = new Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    if (lo === tails.length) tails.push(i);
    else tails[lo] = i;
  }
  const result = [];
  for (let i = tails[tails.length - 1]; i >= 0; i = prev[i]) result.push(i);
  return result.reverse();
}

// 把两边的 hunk 按 base 位置聚类：下一个 hunk 的起点不超过当前段的
// 终点（中间没有公共行）就并进同一段。
function clusterHunks(hunksOurs, hunksTheirs) {
  const all = [...hunksOurs, ...hunksTheirs].sort(
    (x, y) => x.aStart - y.aStart || x.aEnd - y.aEnd,
  );
  const segments = [];
  for (const hunk of all) {
    const last = segments[segments.length - 1];
    if (last && hunk.aStart <= last.aEnd) {
      if (hunk.aEnd > last.aEnd) last.aEnd = hunk.aEnd;
    } else {
      segments.push({ aStart: hunk.aStart, aEnd: hunk.aEnd });
    }
  }
  return segments;
}

// base 边界 -> 某一边边界的映射。before[p] 不含 p 处的插入，after[p] 含。
// 段的起止边界一定落在公共边界上，所以取 slice 时不会碰到 hunk 内部。
function buildBoundaryMaps(nBase, hunks) {
  const before = new Array(nBase + 1).fill(null);
  const after = new Array(nBase + 1).fill(null);
  let delta = 0;
  let hi = 0;
  for (let p = 0; p <= nBase; p++) {
    before[p] = p + delta;
    while (hi < hunks.length && hunks[hi].aStart === p) {
      const hunk = hunks[hi];
      delta = hunk.bEnd - hunk.aEnd;
      if (hunk.aEnd > p) {
        p = hunk.aEnd;
        before[p] = p + delta;
      }
      hi++;
    }
    after[p] = p + delta;
  }
  return { before, after };
}
