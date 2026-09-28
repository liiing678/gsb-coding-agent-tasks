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

function badConfig(message, details = {}) {
  throw new ReplicaError('ERR_BAD_CONFIG', message, details);
}

function badOp(message, details = {}) {
  throw new ReplicaError('ERR_BAD_OP', message, details);
}

function isClientId(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes(':');
}

function validateRemoteOp(op, ownClientId) {
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    badOp('op 必须是一个对象', { op });
  }
  const { id, clientId, seq, type } = op;
  if (!isClientId(clientId)) badOp('op.clientId 不是合法的副本 id', { clientId });
  if (clientId === ownClientId) badOp('收到自己发出去的 op', { clientId });
  if (!Number.isInteger(seq) || seq < 1) badOp('op.seq 必须是正整数', { seq });
  if (id !== `${clientId}:${seq}`) badOp('op.id 与 clientId/seq 对不上', { id, clientId, seq });
  if (type === 'insert') {
    if (op.after !== null && (typeof op.after !== 'string' || op.after.length === 0)) {
      badOp('insert op 的 after 必须是 null 或字符 id', { after: op.after });
    }
    if (!Array.isArray(op.chars) || op.chars.length === 0) {
      badOp('insert op 的 chars 必须是非空数组', { chars: op.chars });
    }
    op.chars.forEach((one, offset) => {
      if (one === null || typeof one !== 'object') badOp('chars 里的字符必须是对象', { one });
      if (one.id !== charId(clientId, seq, offset)) badOp('字符 id 与 op 对不上', { one, offset });
      if (typeof one.ch !== 'string' || one.ch.length !== 1) badOp('字符必须是单个码元', { one });
    });
  } else if (type === 'delete') {
    if (!Array.isArray(op.ids) || op.ids.length === 0) {
      badOp('delete op 的 ids 必须是非空数组', { ids: op.ids });
    }
    for (const target of op.ids) {
      if (typeof target !== 'string' || target.length === 0) badOp('ids 里必须是字符 id', { target });
    }
  } else {
    badOp('op.type 只认 insert / delete', { type });
  }
}

export function createReplica(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    badConfig('配置必须是一个对象', { config });
  }
  const { clientId } = config;
  if (!isClientId(clientId)) badConfig('clientId 必须是不含冒号的非空字符串', { clientId });

  const root = { id: null, children: [] };
  const nodes = new Map();
  const appliedSeq = new Map();
  const buffers = new Map();
  let seq = 0;
  let local = 0;
  let received = 0;
  let duplicates = 0;

  function addChild(parent, node) {
    const siblings = parent.children;
    let at = 0;
    while (at < siblings.length) {
      const sibling = siblings[at];
      const before = sibling.seq > node.seq
        || (sibling.seq === node.seq && sibling.clientId > node.clientId);
      if (!before) break;
      at += 1;
    }
    siblings.splice(at, 0, node);
  }

  function collect(node, out) {
    for (const child of node.children) {
      out.push(child);
      collect(child, out);
    }
  }

  function visibleNodes() {
    const all = [];
    collect(root, all);
    return all.filter((node) => !node.deleted);
  }

  function applyInsert(op) {
    let parent = op.after === null ? root : nodes.get(op.after);
    for (const one of op.chars) {
      const node = {
        id: one.id,
        ch: one.ch,
        clientId: op.clientId,
        seq: op.seq,
        deleted: false,
        children: [],
      };
      nodes.set(node.id, node);
      addChild(parent, node);
      parent = node;
    }
  }

  function applyDelete(op) {
    for (const id of op.ids) {
      const node = nodes.get(id);
      if (node) node.deleted = true;
    }
  }

  function depsReady(op) {
    if (op.type === 'insert') return op.after === null || nodes.has(op.after);
    return op.ids.every((id) => nodes.has(id));
  }

  function applyRemote(op) {
    if (op.type === 'insert') applyInsert(op);
    else applyDelete(op);
    appliedSeq.set(op.clientId, op.seq);
    received += 1;
  }

  function buffer(op) {
    let queue = buffers.get(op.clientId);
    if (!queue) {
      queue = new Map();
      buffers.set(op.clientId, queue);
    }
    if (queue.has(op.seq)) {
      duplicates += 1;
      return;
    }
    queue.set(op.seq, op);
  }

  function drain() {
    let progress = true;
    while (progress) {
      progress = false;
      for (const [source, queue] of buffers) {
        const next = (appliedSeq.get(source) ?? 0) + 1;
        const op = queue.get(next);
        if (op && depsReady(op)) {
          queue.delete(next);
          applyRemote(op);
          progress = true;
        }
      }
    }
  }

  function insert(index, text) {
    const visible = visibleNodes();
    if (!Number.isInteger(index) || index < 0 || index > visible.length) {
      badOp('insert 的 index 超出当前文本范围', { index, length: visible.length });
    }
    if (typeof text !== 'string' || text.length === 0) {
      badOp('insert 的 text 必须是非空字符串', { text });
    }
    seq += 1;
    const after = index === 0 ? null : visible[index - 1].id;
    const chars = text.split('').map((ch, offset) => ({ id: charId(clientId, seq, offset), ch }));
    const op = { id: `${clientId}:${seq}`, clientId, seq, type: 'insert', after, chars };
    applyInsert(op);
    local += 1;
    return op;
  }

  function remove(index, length) {
    const visible = visibleNodes();
    if (!Number.isInteger(length) || length < 1) {
      badOp('delete 的 length 必须是正整数', { length });
    }
    if (!Number.isInteger(index) || index < 0 || index >= visible.length) {
      badOp('delete 的 index 超出当前文本范围', { index, length: visible.length });
    }
    if (index + length > visible.length) {
      badOp('delete 的范围超出当前文本', { index, length, text: visible.length });
    }
    seq += 1;
    const targets = visible.slice(index, index + length);
    for (const node of targets) node.deleted = true;
    local += 1;
    return { id: `${clientId}:${seq}`, clientId, seq, type: 'delete', ids: targets.map((node) => node.id) };
  }

  function receive(op) {
    validateRemoteOp(op, clientId);
    const applied = appliedSeq.get(op.clientId) ?? 0;
    if (op.seq <= applied) {
      duplicates += 1;
      return false;
    }
    if (op.seq !== applied + 1 || !depsReady(op)) {
      buffer(op);
      return false;
    }
    applyRemote(op);
    drain();
    return true;
  }

  function stats() {
    let buffered = 0;
    for (const queue of buffers.values()) buffered += queue.size;
    return {
      clientId,
      local,
      received,
      buffered,
      duplicates,
      chars: nodes.size,
      visible: visibleNodes().length,
    };
  }

  return {
    clientId,
    get text() {
      return visibleNodes().map((node) => node.ch).join('');
    },
    insert,
    delete: remove,
    receive,
    stats,
  };
}
