// 行级三方合并。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/basic|conflict|policy）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）和切行工具（lib/lines.js）
// 都已经按 README 的《口径》和《API》两节写好了。那些约定不要改，把这里补出来。

import { MergeError } from './errors.js';
import { splitLines, joinLines } from './lines.js';

export const DEFAULTS = {
  conflictStyle: 'markers', // markers | ours | theirs | union
  markerLayout: 'diff3',    // diff3 | merge
  oursLabel: 'ours',
  baseLabel: 'base',
  theirsLabel: 'theirs',
};

// 单边行数上限。
export const MAX_LINES = 20000;

export function mergeThreeWay(base, ours, theirs, options = {}) {
  for (const [field, value] of [['base', base], ['ours', ours], ['theirs', theirs]]) {
    if (typeof value !== 'string') {
      throw new MergeError('ERR_BAD_INPUT', `${field} 必须是字符串`, { field });
    }
  }

  const opts = { ...DEFAULTS, ...(options ?? {}) };
  const styles = new Set(['markers', 'ours', 'theirs', 'union']);
  const layouts = new Set(['diff3', 'merge']);
  if (!styles.has(opts.conflictStyle)) {
    throw new MergeError(
      'ERR_BAD_OPTION',
      `不认识的 conflictStyle：${String(opts.conflictStyle)}`,
    );
  }
  if (!layouts.has(opts.markerLayout)) {
    throw new MergeError(
      'ERR_BAD_OPTION',
      `不认识的 markerLayout：${String(opts.markerLayout)}`,
    );
  }
  if (opts.conflictStyle === 'markers') {
    for (const label of [opts.oursLabel, opts.baseLabel, opts.theirsLabel]) {
      if (typeof label !== 'string' || label.length === 0) {
        throw new MergeError('ERR_BAD_OPTION', 'markers 风格下三个标签都必须是非空字符串');
      }
    }
  }

  const baseLines = splitLines(base);
  const oursLines = splitLines(ours);
  const theirsLines = splitLines(theirs);
  for (const [field, lines] of [
    ['base', baseLines],
    ['ours', oursLines],
    ['theirs', theirsLines],
  ]) {
    if (lines.length > MAX_LINES) {
      throw new MergeError(
        'ERR_TOO_MANY_LINES',
        `${field} 有 ${lines.length} 行，超过上限 ${MAX_LINES}`,
        { field, lines: lines.length, max: MAX_LINES },
      );
    }
  }

  // base 行在两边各自 LCS 对齐里的落点；两边都对得上的 base 行才算公共行。
  const matchOurs = alignLcs(baseLines, oursLines);
  const matchTheirs = alignLcs(baseLines, theirsLines);

  const output = [];
  const conflicts = [];
  let segmentCount = 0;
  let conflictCount = 0;
  let addedLines = 0;
  let removedLines = 0;

  const rangeEquals = (left, leftStart, leftEnd, right, rightStart, rightEnd) => {
    if (leftEnd - leftStart !== rightEnd - rightStart) return false;
    for (let offset = 0; offset < leftEnd - leftStart; offset++) {
      if (left[leftStart + offset] !== right[rightStart + offset]) return false;
    }
    return true;
  };

  const appendRange = (lines, start, end) => {
    for (let i = start; i < end; i++) output.push(lines[i]);
  };

  // 两个相邻公共行之间的空当（文件首尾也算）：至少一边有内容就是一段。
  const processGap = (baseStart, baseEnd, oursStart, oursEnd, theirsStart, theirsEnd) => {
    const baseLen = baseEnd - baseStart;
    const oursLen = oursEnd - oursStart;
    const theirsLen = theirsEnd - theirsStart;
    if (baseLen === 0 && oursLen === 0 && theirsLen === 0) return;

    const oursEqBase = rangeEquals(
      baseLines, baseStart, baseEnd, oursLines, oursStart, oursEnd,
    );
    const theirsEqBase = rangeEquals(
      baseLines, baseStart, baseEnd, theirsLines, theirsStart, theirsEnd,
    );

    // 重复行导致的对齐错位：两边其实都没动，按公共内容放过去，不算段。
    if (oursEqBase && theirsEqBase) {
      appendRange(baseLines, baseStart, baseEnd);
      return;
    }

    segmentCount += 1;
    const oursEqTheirs = rangeEquals(
      oursLines, oursStart, oursEnd, theirsLines, theirsStart, theirsEnd,
    );
    const isConflict = !oursEqTheirs && !oursEqBase && !theirsEqBase;

    if (!isConflict) {
      if (theirsEqBase) {
        appendRange(oursLines, oursStart, oursEnd);
        addedLines += oursLen;
      } else {
        // 要么只有我们没动（取他们），要么两边产出一致（取这一份）。
        appendRange(theirsLines, theirsStart, theirsEnd);
        addedLines += theirsLen;
      }
      removedLines += baseLen;
      return;
    }

    conflictCount += 1;
    conflicts.push({
      index: conflictCount,
      outputLine: output.length + 1,
      oursCount: oursLen,
      baseCount: baseLen,
      theirsCount: theirsLen,
    });

    if (opts.conflictStyle === 'markers') {
      output.push(`<<<<<<< ${opts.oursLabel}`);
      appendRange(oursLines, oursStart, oursEnd);
      if (opts.markerLayout === 'diff3') {
        output.push(`||||||| ${opts.baseLabel}`);
        appendRange(baseLines, baseStart, baseEnd);
      }
      output.push('=======');
      appendRange(theirsLines, theirsStart, theirsEnd);
      output.push(`>>>>>>> ${opts.theirsLabel}`);
      if (opts.markerLayout === 'diff3') {
        // base 段原样留在输出里，没有删除；4 行标记和两边产出都算新增。
        addedLines += 4 + oursLen + theirsLen;
      } else {
        removedLines += baseLen;
        addedLines += 3 + oursLen + theirsLen;
      }
    } else if (opts.conflictStyle === 'ours') {
      appendRange(oursLines, oursStart, oursEnd);
      removedLines += baseLen;
      addedLines += oursLen;
    } else if (opts.conflictStyle === 'theirs') {
      appendRange(theirsLines, theirsStart, theirsEnd);
      removedLines += baseLen;
      addedLines += theirsLen;
    } else {
      // union：我们这边全留，他们那边没在我们这边出现过的行按顺序接上。
      const before = output.length;
      const seen = new Set();
      for (let i = oursStart; i < oursEnd; i++) {
        seen.add(oursLines[i]);
        output.push(oursLines[i]);
      }
      for (let i = theirsStart; i < theirsEnd; i++) {
        if (!seen.has(theirsLines[i])) output.push(theirsLines[i]);
      }
      removedLines += baseLen;
      addedLines += output.length - before;
    }
  };

  // 顺着公共行走一遍，公共行原样输出，相邻公共行之间交给 processGap。
  let baseCursor = 0;
  let oursCursor = 0;
  let theirsCursor = 0;
  for (let baseIndex = 0; baseIndex < baseLines.length; baseIndex++) {
    const oursIndex = matchOurs[baseIndex];
    const theirsIndex = matchTheirs[baseIndex];
    if (oursIndex === -1 || theirsIndex === -1) continue;

    processGap(
      baseCursor, baseIndex,
      oursCursor, oursIndex,
      theirsCursor, theirsIndex,
    );
    output.push(baseLines[baseIndex]);
    baseCursor = baseIndex + 1;
    oursCursor = oursIndex + 1;
    theirsCursor = theirsIndex + 1;
  }
  processGap(
    baseCursor, baseLines.length,
    oursCursor, oursLines.length,
    theirsCursor, theirsLines.length,
  );

  return {
    text: joinLines(output),
    clean: conflictCount === 0,
    conflicts,
    stats: {
      segments: segmentCount,
      conflicts: conflictCount,
      addedLines,
      removedLines,
    },
  };
}

// 返回长度和 base 相同的数组：match[i] 是 base[i] 在 side 里对齐到的下标，没对齐为 -1。
// Hunt–Szymanski：按行内容建桶，贪心维护各长度 LCS 的最小结尾，O((n+R) log n)。
function alignLcs(base, side) {
  const match = new Int32Array(base.length).fill(-1);
  if (base.length === 0 || side.length === 0) return match;

  if (base.length === side.length) {
    let identical = true;
    for (let i = 0; i < base.length; i++) {
      if (base[i] !== side[i]) {
        identical = false;
        break;
      }
    }
    if (identical) {
      for (let i = 0; i < base.length; i++) match[i] = i;
      return match;
    }
  }

  const buckets = new Map();
  for (let i = 0; i < base.length; i++) {
    const list = buckets.get(base[i]);
    if (list) list.push(i);
    else buckets.set(base[i], [i]);
  }

  // 重复行极端多时潜在对数 R 会到 n^2，换 patience 对齐兜底。
  let pairCount = 0;
  for (const line of side) {
    const list = buckets.get(line);
    if (list) pairCount += list.length;
  }
  if (pairCount > 1_000_000) return alignPatience(base, side);

  const thresholds = [];
  const thresholdNodes = [];
  const nodeBase = [];
  const nodeSide = [];
  const nodePrev = [];

  for (let sideIndex = 0; sideIndex < side.length; sideIndex++) {
    const positions = buckets.get(side[sideIndex]);
    if (!positions) continue;
    for (let k = positions.length - 1; k >= 0; k--) {
      const baseIndex = positions[k];
      let low = 0;
      let high = thresholds.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (thresholds[mid] < sideIndex) low = mid + 1;
        else high = mid;
      }
      const lengthIndex = low;
      const nodeId = nodeBase.length;
      nodeBase.push(baseIndex);
      nodeSide.push(sideIndex);
      nodePrev.push(lengthIndex > 0 ? thresholdNodes[lengthIndex - 1] : -1);
      if (lengthIndex === thresholds.length) {
        thresholds.push(sideIndex);
        thresholdNodes.push(nodeId);
      } else {
        thresholds[lengthIndex] = sideIndex;
        thresholdNodes[lengthIndex] = nodeId;
      }
    }
  }

  let nodeId = thresholdNodes.length > 0
    ? thresholdNodes[thresholdNodes.length - 1]
    : -1;
  while (nodeId !== -1) {
    match[nodeBase[nodeId]] = nodeSide[nodeId];
    nodeId = nodePrev[nodeId];
  }
  return match;
}

// patience 对齐：只用两边各自只出现一次的公共行做锚点，锚点之间再递归。
function alignPatience(base, side) {
  const match = new Int32Array(base.length).fill(-1);

  const walk = (baseStart, baseEnd, sideStart, sideEnd) => {
    if (baseStart >= baseEnd || sideStart >= sideEnd) return;

    const uniqueInBase = new Map();
    for (let i = baseStart; i < baseEnd; i++) {
      const line = base[i];
      if (!uniqueInBase.has(line)) uniqueInBase.set(line, i);
      else if (uniqueInBase.get(line) !== -1) uniqueInBase.set(line, -1);
    }

    const sideCount = new Map();
    const pairs = [];
    for (let j = sideStart; j < sideEnd; j++) {
      const line = side[j];
      const count = sideCount.get(line) ?? 0;
      sideCount.set(line, count + 1);
      const baseIndex = uniqueInBase.get(line);
      if (count === 0 && baseIndex !== undefined && baseIndex !== -1) {
        pairs.push([baseIndex, j]);
      }
    }
    const validPairs = pairs.filter(([, j]) => sideCount.get(side[j]) === 1);
    if (validPairs.length === 0) {
      // 没有唯一公共行：逐行贪心对齐相同行，行数多的一边先让一步。
      // 这仍然只连内容相同的行，不会改变合并结果，只影响段的粒度。
      let baseIndex = baseStart;
      let sideIndex = sideStart;
      while (baseIndex < baseEnd && sideIndex < sideEnd) {
        if (base[baseIndex] === side[sideIndex]) {
          match[baseIndex] = sideIndex;
          baseIndex += 1;
          sideIndex += 1;
        } else if (baseEnd - baseIndex > sideEnd - sideIndex) {
          baseIndex += 1;
        } else {
          sideIndex += 1;
        }
      }
      return;
    }

    // 按 base 下标取严格递增的最长子序列，即 patience 锚点链。
    const tails = [];
    const tailPair = [];
    const previous = new Array(validPairs.length).fill(-1);
    for (let k = 0; k < validPairs.length; k++) {
      const baseIndex = validPairs[k][0];
      let low = 0;
      let high = tails.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (tails[mid] < baseIndex) low = mid + 1;
        else high = mid;
      }
      previous[k] = low > 0 ? tailPair[low - 1] : -1;
      if (low === tails.length) {
        tails.push(baseIndex);
        tailPair.push(k);
      } else {
        tails[low] = baseIndex;
        tailPair[low] = k;
      }
    }

    const anchors = [];
    let pairIndex = tailPair[tailPair.length - 1];
    while (pairIndex !== -1) {
      anchors.push(validPairs[pairIndex]);
      pairIndex = previous[pairIndex];
    }
    anchors.reverse();

    let prevBase = baseStart;
    let prevSide = sideStart;
    for (const [anchorBase, anchorSide] of anchors) {
      walk(prevBase, anchorBase, prevSide, anchorSide);
      match[anchorBase] = anchorSide;
      prevBase = anchorBase + 1;
      prevSide = anchorSide + 1;
    }
    walk(prevBase, baseEnd, prevSide, sideEnd);
  };

  walk(0, base.length, 0, side.length);
  return match;
}
