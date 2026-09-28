// 协同编辑文本副本。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/edit.test.js、test/merge.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import { ReplicaError } from './errors.js';

export const DEFAULTS = {
  localPrefix: '',
};

export function charId(clientId, seq, offset) {
  return `${clientId}:${seq}:${offset}`;
}

export function createReplica(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)
    || typeof config.clientId !== 'string'
    || config.clientId.length === 0
    || config.clientId.includes(':')) {
    throw new ReplicaError('ERR_BAD_CONFIG', 'clientId 必须是不含冒号的非空字符串');
  }

  const clientId = config.clientId;

  // 字符树：根是虚拟节点（id 为 null）。每个字符一个节点，删除只打墓碑，
  // 节点和子节点都保留，所以锚在墓碑上的插入不会丢。
  const root = { id: null, ch: '', dead: false, seq: 0, author: '', kids: [] };
  const byId = new Map();

  let localSeq = 0;
  let localCount = 0;
  let receivedCount = 0;
  let duplicateCount = 0;

  // 每个来源副本：applied = 已应用到的 seq，buffers = 压着等落位的 op。
  const applied = new Map();
  const buffers = new Map();

  function badOp(message) {
    throw new ReplicaError('ERR_BAD_OP', message);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  // 同一锚点下的兄弟：seq 大的在前，seq 相同 clientId 大的在前。
  function comesBefore(incoming, existing) {
    if (incoming.seq !== existing.seq) return incoming.seq > existing.seq;
    return incoming.author > existing.author;
  }

  function insertSibling(parent, node) {
    const kids = parent.kids;
    let index = 0;
    while (index < kids.length && !comesBefore(node, kids[index])) index += 1;
    kids.splice(index, 0, node);
  }

  function applyInsert(op) {
    let parent = op.after === null ? root : byId.get(op.after);
    for (const piece of op.chars) {
      const node = {
        id: piece.id, ch: piece.ch, dead: false,
        seq: op.seq, author: op.clientId, kids: [],
      };
      byId.set(piece.id, node);
      insertSibling(parent, node);
      parent = node;
    }
  }

  function applyDelete(op) {
    for (const id of op.ids) {
      byId.get(id).dead = true;
    }
  }

  function applyOp(op) {
    if (op.type === 'insert') applyInsert(op);
    else applyDelete(op);
  }

  function depsReady(op) {
    if (op.type === 'insert') {
      return op.after === null || byId.has(op.after);
    }
    return op.ids.every((id) => byId.has(id));
  }

  // 深度优先走一遍树，墓碑跳过但继续走它的子树。
  function visibleNodes() {
    const list = [];
    const walk = (node) => {
      if (node !== root && !node.dead) list.push(node);
      for (const kid of node.kids) walk(kid);
    };
    walk(root);
    return list;
  }

  function render() {
    let out = '';
    for (const node of visibleNodes()) out += node.ch;
    return out;
  }

  function insert(index, text) {
    const visible = visibleNodes();
    if (!Number.isInteger(index) || index < 0 || index > visible.length) {
      badOp('insert 的 index 越界或不是整数');
    }
    if (typeof text !== 'string' || text.length === 0) {
      badOp('insert 的 text 必须是非空字符串');
    }

    localSeq += 1;
    const seq = localSeq;
    const anchor = index === 0 ? null : visible[index - 1].id;
    const chars = [];
    for (let offset = 0; offset < text.length; offset += 1) {
      chars.push({ id: charId(clientId, seq, offset), ch: text[offset] });
    }
    const op = {
      id: `${clientId}:${seq}`, clientId, seq,
      type: 'insert', after: anchor, chars,
    };
    applyInsert(op);
    localCount += 1;
    return op;
  }

  function remove(index, length) {
    const visible = visibleNodes();
    if (!Number.isInteger(index) || index < 0 || index >= visible.length) {
      badOp('delete 的 index 越界或不是整数');
    }
    if (!Number.isInteger(length) || length <= 0 || index + length > visible.length) {
      badOp('delete 的 length 不合法');
    }

    localSeq += 1;
    const seq = localSeq;
    const ids = visible.slice(index, index + length).map((node) => node.id);
    const op = { id: `${clientId}:${seq}`, clientId, seq, type: 'delete', ids };
    applyDelete(op);
    localCount += 1;
    return op;
  }

  function validateRemote(op) {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      badOp('op 必须是对象');
    }
    if (!isNonEmptyString(op.id)) badOp('op.id 必须是非空字符串');
    if (!isNonEmptyString(op.clientId) || op.clientId.includes(':')) {
      badOp('op.clientId 必须是不含冒号的非空字符串');
    }
    if (!Number.isInteger(op.seq) || op.seq < 1) badOp('op.seq 必须是正整数');
    if (op.clientId === clientId) badOp('不能收自己发出去的 op');

    if (op.type === 'insert') {
      if (op.after !== null && !isNonEmptyString(op.after)) {
        badOp('insert 的 after 必须是 null 或字符 id');
      }
      if (!Array.isArray(op.chars) || op.chars.length === 0) {
        badOp('insert 的 chars 必须是非空数组');
      }
      for (const piece of op.chars) {
        if (piece === null || typeof piece !== 'object'
          || !isNonEmptyString(piece.id)
          || typeof piece.ch !== 'string' || piece.ch.length !== 1) {
          badOp('chars 里每一项都要有 id 和一个 UTF-16 码元的 ch');
        }
      }
    } else if (op.type === 'delete') {
      if (!Array.isArray(op.ids) || op.ids.length === 0
        || op.ids.some((id) => !isNonEmptyString(id))) {
        badOp('delete 的 ids 必须是非空字符串数组');
      }
    } else {
      badOp('op.type 只能是 insert 或 delete');
    }
  }

  // 反复把"seq 接上且依赖已到"的缓冲 op 按 seq 落位，返回 target 是否在这一趟落了地。
  function flush(target) {
    let targetApplied = false;
    for (;;) {
      let progressed = false;
      for (const source of [...buffers.keys()]) {
        const map = buffers.get(source);
        const expected = (applied.get(source) ?? 0) + 1;
        const op = map.get(expected);
        if (op && depsReady(op)) {
          map.delete(expected);
          if (map.size === 0) buffers.delete(source);
          applyOp(op);
          applied.set(source, expected);
          receivedCount += 1;
          if (op === target) targetApplied = true;
          progressed = true;
        }
      }
      if (!progressed) return targetApplied;
    }
  }

  function receive(op) {
    validateRemote(op);
    const source = op.clientId;
    const done = applied.get(source) ?? 0;

    if (op.seq <= done) {
      duplicateCount += 1;
      return false;
    }

    let appliedNow = false;
    if (op.seq === done + 1 && depsReady(op)) {
      applyOp(op);
      applied.set(source, op.seq);
      receivedCount += 1;
      appliedNow = true;
    } else {
      if (!buffers.has(source)) buffers.set(source, new Map());
      buffers.get(source).set(op.seq, op);
    }

    if (flush(op)) appliedNow = true;
    return appliedNow;
  }

  function stats() {
    let buffered = 0;
    for (const map of buffers.values()) buffered += map.size;
    return {
      clientId,
      local: localCount,
      received: receivedCount,
      buffered,
      duplicates: duplicateCount,
      chars: byId.size,
      visible: render().length,
    };
  }

  return {
    clientId,
    insert,
    delete: remove,
    receive,
    stats,
    get text() {
      return render();
    },
  };
}
