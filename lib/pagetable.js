// piece table 文本缓冲内核：编辑、分行定位、撤销重做与事务。
//
// 内容存两份底稿：original（创建时传入，之后不改）和 add（只增不减，撤销/回滚都不缩）。
// 当前内容是若干 { source, start, length } 块拼起来的视图；长度一律按 UTF-16 code unit。

import { PagetableError } from './errors.js';

const badArgument = (message, details) => new PagetableError('ERR_BAD_ARGUMENT', message, details);
const outOfRange = (message, details) => new PagetableError('ERR_OUT_OF_RANGE', message, details);

const assertString = (value, name) => {
  if (typeof value !== 'string') {
    throw badArgument(`${name} 必须是字符串`, { [name]: value });
  }
};

const assertNonNegativeInteger = (value, name) => {
  if (!Number.isInteger(value) || value < 0) {
    throw badArgument(`${name} 必须是非负整数`, { [name]: value });
  }
};

export function createBuffer(text = '') {
  assertString(text, 'text');

  const original = text;
  let add = '';
  let pieces = text.length > 0 ? [{ source: 'original', start: 0, length: text.length }] : [];
  const undoStack = [];
  const redoStack = [];
  let inTransaction = false;
  let transactionChanged = false;

  const snapshot = () => pieces.slice();

  const totalLength = () => pieces.reduce((sum, piece) => sum + piece.length, 0);

  // 丢掉长度 0 的块，并把同源且首尾相接的相邻块并成一块。
  const normalize = () => {
    const merged = [];
    for (const piece of pieces) {
      if (piece.length === 0) continue;
      const last = merged[merged.length - 1];
      if (last && last.source === piece.source && last.start + last.length === piece.start) {
        merged[merged.length - 1] = { source: last.source, start: last.start, length: last.length + piece.length };
      } else {
        merged.push(piece);
      }
    }
    pieces = merged;
  };

  const sourceText = (source) => (source === 'original' ? original : add);

  // 在 offset 处把新内容追加到 add 区尾巴，并把落点那块切成「前半 + 新块 + 后半」。
  const insertPieces = (offset, inserted) => {
    const piece = { source: 'add', start: add.length, length: inserted.length };
    add += inserted;
    let walked = 0;
    for (let index = 0; index < pieces.length; index += 1) {
      const current = pieces[index];
      if (offset === walked) {
        pieces.splice(index, 0, piece);
        return;
      }
      if (offset < walked + current.length) {
        const cut = offset - walked;
        const left = { source: current.source, start: current.start, length: cut };
        const right = {
          source: current.source,
          start: current.start + cut,
          length: current.length - cut,
        };
        pieces.splice(index, 1, left, piece, right);
        return;
      }
      walked += current.length;
    }
    pieces.push(piece);
  };

  // 把每块跟 [offset, offset + count) 重叠的部分削掉。
  const deletePieces = (offset, count) => {
    const end = offset + count;
    const kept = [];
    let walked = 0;
    for (const piece of pieces) {
      const pieceStart = walked;
      const pieceEnd = walked + piece.length;
      walked = pieceEnd;
      if (pieceEnd <= offset || pieceStart >= end) {
        kept.push(piece);
        continue;
      }
      if (pieceStart < offset) {
        kept.push({ source: piece.source, start: piece.start, length: offset - pieceStart });
      }
      if (pieceEnd > end) {
        kept.push({
          source: piece.source,
          start: piece.start + (end - pieceStart),
          length: pieceEnd - end,
        });
      }
    }
    pieces = kept;
  };

  // 真正改内容的编辑走这里：事务里只标记，事务外压一步撤销记录并清空重做栈。
  const applyEdit = (mutate) => {
    if (inTransaction) {
      transactionChanged = true;
      mutate();
      return;
    }
    const before = snapshot();
    mutate();
    undoStack.push(before);
    redoStack.length = 0;
  };

  const checkRange = (offset, count) => {
    if (offset + count > totalLength()) {
      throw outOfRange('offset + count 超出内容长度', { offset, count, length: totalLength() });
    }
  };

  const fullText = () => pieces.map((piece) => {
    const source = sourceText(piece.source);
    return source.slice(piece.start, piece.start + piece.length);
  }).join('');

  const lines = () => fullText().split('\n');

  const api = {
    text: () => fullText(),

    length: () => totalLength(),

    slice(offset, count) {
      assertNonNegativeInteger(offset, 'offset');
      assertNonNegativeInteger(count, 'count');
      checkRange(offset, count);
      const end = offset + count;
      let result = '';
      let walked = 0;
      for (const piece of pieces) {
        const pieceStart = walked;
        const pieceEnd = walked + piece.length;
        walked = pieceEnd;
        if (pieceEnd <= offset || pieceStart >= end) continue;
        const from = Math.max(offset, pieceStart) - pieceStart;
        const to = Math.min(end, pieceEnd) - pieceStart;
        const source = sourceText(piece.source);
        result += source.slice(piece.start + from, piece.start + to);
      }
      return result;
    },

    insert(offset, inserted) {
      assertNonNegativeInteger(offset, 'offset');
      assertString(inserted, 'text');
      if (offset > totalLength()) {
        throw outOfRange('offset 超出内容长度', { offset, length: totalLength() });
      }
      if (inserted.length === 0) return;
      applyEdit(() => {
        insertPieces(offset, inserted);
        normalize();
      });
    },

    delete(offset, count) {
      assertNonNegativeInteger(offset, 'offset');
      assertNonNegativeInteger(count, 'count');
      checkRange(offset, count);
      if (count === 0) return;
      applyEdit(() => {
        deletePieces(offset, count);
        normalize();
      });
    },

    replace(offset, count, replacement) {
      assertNonNegativeInteger(offset, 'offset');
      assertNonNegativeInteger(count, 'count');
      assertString(replacement, 'text');
      checkRange(offset, count);
      if (count === 0 && replacement.length === 0) return;
      // 一次 replace 只压一步撤销记录。
      applyEdit(() => {
        if (count > 0) deletePieces(offset, count);
        if (replacement.length > 0) insertPieces(offset, replacement);
        normalize();
      });
    },

    lineCount: () => lines().length,

    lineAt(line) {
      assertNonNegativeInteger(line, 'line');
      const all = lines();
      if (line >= all.length) {
        throw outOfRange('行号越界', { line, lines: all.length });
      }
      return all[line];
    },

    positionAt(offset) {
      assertNonNegativeInteger(offset, 'offset');
      const content = fullText();
      if (offset > content.length) {
        throw outOfRange('offset 超出内容长度', { offset, length: content.length });
      }
      let line = 0;
      let lineStart = 0;
      for (let index = 0; index < offset; index += 1) {
        if (content[index] === '\n') {
          line += 1;
          lineStart = index + 1;
        }
      }
      return { line, column: offset - lineStart };
    },

    offsetAt(line, column) {
      assertNonNegativeInteger(line, 'line');
      assertNonNegativeInteger(column, 'column');
      const all = lines();
      if (line >= all.length) {
        throw outOfRange('行号越界', { line, lines: all.length });
      }
      if (column > all[line].length) {
        throw outOfRange('列号超过该行长度', { line, column, lineLength: all[line].length });
      }
      let offset = 0;
      for (let index = 0; index < line; index += 1) {
        offset += all[index].length + 1;
      }
      return offset + column;
    },

    undo() {
      if (undoStack.length === 0) return false;
      redoStack.push(snapshot());
      pieces = undoStack.pop();
      return true;
    },

    redo() {
      if (redoStack.length === 0) return false;
      undoStack.push(snapshot());
      pieces = redoStack.pop();
      return true;
    },

    transaction(fn) {
      if (typeof fn !== 'function') {
        throw badArgument('transaction 需要一个函数', { fn });
      }
      if (inTransaction) {
        throw new PagetableError('ERR_NESTED_TRANSACTION', '事务不能嵌套');
      }
      inTransaction = true;
      transactionChanged = false;
      const before = snapshot();
      try {
        fn();
      } catch (err) {
        // 整体回滚到事务开始前，撤销/重做栈都不留痕迹。
        pieces = before;
        inTransaction = false;
        transactionChanged = false;
        throw err;
      }
      inTransaction = false;
      if (transactionChanged) {
        transactionChanged = false;
        undoStack.push(before);
        redoStack.length = 0;
      }
      return undefined;
    },

    stats: () => ({
      length: totalLength(),
      lines: lines().length,
      pieces: pieces.length,
      addLength: add.length,
      undoDepth: undoStack.length,
      redoDepth: redoStack.length,
    }),
  };

  return api;
}
