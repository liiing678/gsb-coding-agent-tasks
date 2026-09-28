// piece table 文本缓冲内核：编辑、分行定位、撤销重做与事务。
//
// 内容由两份底稿拼出：original 只读不改，add 只在尾巴上追加（撤销、事务回滚都不缩回）。
// 当前内容是若干块 { source, start, length }，长度一律按 UTF-16 code unit 算。

import { PagetableError } from './errors.js';

const ORIGINAL = 'original';
const ADD = 'add';

const isNonNegativeInt = (value) => Number.isInteger(value) && value >= 0;

const badArgument = (message, details) =>
  new PagetableError('ERR_BAD_ARGUMENT', message, details);
const outOfRange = (message, details) =>
  new PagetableError('ERR_OUT_OF_RANGE', message, details);

const pieceText = (piece, backing) =>
  backing[piece.source].slice(piece.start, piece.start + piece.length);

// 去掉长度 0 的块，再把「同源且首尾相接」的相邻块并成一块。
// 中间被删空了一段的两个同源块 start 对不上，不算相接，不会被合并。
function normalizePieces(pieces) {
  const merged = [];
  for (const piece of pieces) {
    if (piece.length === 0) continue;
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.source === piece.source &&
      prev.start + prev.length === piece.start
    ) {
      prev.length += piece.length;
    } else {
      merged.push({ ...piece });
    }
  }
  return merged;
}

// 唯一的编辑原语：在 [start, start + removeCount) 处换上 addStart 起的 insertLength 个字符。
// 用光标扫一遍块，按「落点之前 / 新块 / 落点之后」产出新块列表，完全不碰两份底稿。
function splicePieces(pieces, start, removeCount, addStart, insertLength) {
  const end = start + removeCount;
  let cursor = 0;
  const left = [];
  const right = [];

  for (const piece of pieces) {
    const pieceEnd = cursor + piece.length;
    const headEnd = Math.min(pieceEnd, start);
    if (headEnd > cursor) {
      left.push({ source: piece.source, start: piece.start, length: headEnd - cursor });
    }
    const tailStart = Math.max(cursor, end);
    if (tailStart < pieceEnd) {
      const offset = tailStart - cursor;
      right.push({
        source: piece.source,
        start: piece.start + offset,
        length: pieceEnd - tailStart,
      });
    }
    cursor = pieceEnd;
  }

  const next = [...left];
  if (insertLength > 0) {
    next.push({ source: ADD, start: addStart, length: insertLength });
  }
  next.push(...right);
  return normalizePieces(next);
}

export function createBuffer(text = '') {
  if (typeof text !== 'string') {
    throw badArgument('createBuffer 的内容必须是字符串', { received: typeof text });
  }

  const backing = { [ORIGINAL]: text, [ADD]: '' };
  let pieces = text.length > 0
    ? [{ source: ORIGINAL, start: 0, length: text.length }]
    : [];
  let undoStack = [];
  let redoStack = [];
  let inTransaction = false;

  const totalLength = () => {
    let length = 0;
    for (const piece of pieces) length += piece.length;
    return length;
  };

  const readText = () => pieces.map((piece) => pieceText(piece, backing)).join('');

  // 提交一次真改动。事务进行中只换当前块表、不动撤销栈，由事务收口时统一压一条；
  // 普通编辑压一条并清空重做栈。
  const commit = (before, nextPieces) => {
    pieces = nextPieces;
    if (!inTransaction) {
      undoStack.push({ before, after: pieces });
      redoStack = [];
    }
  };

  const checkOffset = (offset, length, label = 'offset') => {
    if (!isNonNegativeInt(offset)) {
      throw badArgument(`${label} 必须是非负整数`, { received: offset });
    }
    if (offset > length) {
      throw outOfRange(`${label} 超过内容长度`, { offset, length });
    }
  };

  const checkCount = (count, length, offset) => {
    if (!isNonNegativeInt(count)) {
      throw badArgument('count 必须是非负整数', { received: count });
    }
    if (offset + count > length) {
      throw outOfRange('offset + count 超过内容长度', { offset, count, length });
    }
  };

  const applyReplace = (offset, count, value) => {
    const length = totalLength();
    checkOffset(offset, length);
    checkCount(count, length, offset);
    if (typeof value !== 'string') {
      throw badArgument('插入/替换的内容必须是字符串', { received: typeof value });
    }
    // 插入空串、删 0 个且不写入内容，都不算改动。
    if (count === 0 && value.length === 0) return;

    const before = pieces;
    let nextPieces;
    if (value.length > 0) {
      const addStart = backing[ADD].length;
      backing[ADD] += value;
      nextPieces = splicePieces(pieces, offset, count, addStart, value.length);
    } else {
      nextPieces = splicePieces(pieces, offset, count, 0, 0);
    }
    commit(before, nextPieces);
  };

  // 返回各行行首的绝对偏移；长度按 UTF-16 code unit 算。
  const lineStarts = (fullText) => {
    const starts = [0];
    for (let index = 0; index < fullText.length; index += 1) {
      if (fullText.charCodeAt(index) === 10) starts.push(index + 1);
    }
    return starts;
  };

  const buffer = {
    text() {
      return readText();
    },

    length() {
      return totalLength();
    },

    slice(offset, count) {
      const length = totalLength();
      checkOffset(offset, length);
      checkCount(count, length, offset);
      return readText().slice(offset, offset + count);
    },

    insert(offset, value) {
      if (typeof value !== 'string') {
        throw badArgument('插入的内容必须是字符串', { received: typeof value });
      }
      applyReplace(offset, 0, value);
    },

    delete(offset, count) {
      if (!isNonNegativeInt(count)) {
        throw badArgument('count 必须是非负整数', { received: count });
      }
      applyReplace(offset, count, '');
    },

    replace(offset, count, value) {
      if (typeof value !== 'string') {
        throw badArgument('替换的内容必须是字符串', { received: typeof value });
      }
      applyReplace(offset, count, value);
    },

    lineCount() {
      const fullText = readText();
      return lineStarts(fullText).length;
    },

    lineAt(line) {
      if (!isNonNegativeInt(line)) {
        throw badArgument('line 必须是非负整数', { received: line });
      }
      const fullText = readText();
      const starts = lineStarts(fullText);
      if (line >= starts.length) {
        throw outOfRange('行号越界', { line, lineCount: starts.length });
      }
      const begin = starts[line];
      const end = line + 1 < starts.length ? starts[line + 1] - 1 : fullText.length;
      return fullText.slice(begin, end);
    },

    positionAt(offset) {
      const length = totalLength();
      checkOffset(offset, length);
      const fullText = readText();
      let line = 0;
      let lineStart = 0;
      for (let index = 0; index < offset; index += 1) {
        if (fullText.charCodeAt(index) === 10) {
          line += 1;
          lineStart = index + 1;
        }
      }
      return { line, column: offset - lineStart };
    },

    offsetAt(line, column) {
      if (!isNonNegativeInt(line)) {
        throw badArgument('line 必须是非负整数', { received: line });
      }
      if (!isNonNegativeInt(column)) {
        throw badArgument('column 必须是非负整数', { received: column });
      }
      const fullText = readText();
      const starts = lineStarts(fullText);
      if (line >= starts.length) {
        throw outOfRange('行号越界', { line, lineCount: starts.length });
      }
      const begin = starts[line];
      const end = line + 1 < starts.length ? starts[line + 1] - 1 : fullText.length;
      const lineLength = end - begin;
      if (column > lineLength) {
        throw outOfRange('列号超过该行长度', { line, column, lineLength });
      }
      return begin + column;
    },

    undo() {
      const entry = undoStack.pop();
      if (!entry) return false;
      pieces = entry.before;
      redoStack.push(entry);
      return true;
    },

    redo() {
      const entry = redoStack.pop();
      if (!entry) return false;
      pieces = entry.after;
      undoStack.push(entry);
      return true;
    },

    transaction(fn) {
      if (typeof fn !== 'function') {
        throw badArgument('transaction 收的必须是函数', { received: typeof fn });
      }
      if (inTransaction) {
        throw new PagetableError(
          'ERR_NESTED_TRANSACTION',
          '事务不能嵌套',
        );
      }

      const before = pieces;
      const undoBefore = undoStack;
      const redoBefore = redoStack;
      inTransaction = true;
      try {
        const result = fn();
        // 块表还是事务开始时那份引用 = 啥都没改，不压撤销记录。
        if (pieces !== before) {
          undoBefore.push({ before, after: pieces });
          redoStack = [];
        }
        return result;
      } catch (err) {
        // 整块回滚：块表和两个栈都恢复成事务开始前；add 区追加的内容留着不缩。
        pieces = before;
        undoStack = undoBefore;
        redoStack = redoBefore;
        throw err;
      } finally {
        inTransaction = false;
      }
    },

    stats() {
      const fullText = readText();
      return {
        length: totalLength(),
        lines: lineStarts(fullText).length,
        pieces: pieces.length,
        addLength: backing[ADD].length,
        undoDepth: undoStack.length,
        redoDepth: redoStack.length,
      };
    },
  };

  return buffer;
}
