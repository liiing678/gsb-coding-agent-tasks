// 带预写日志的本地 KV：先写日志再改内存，靠重放恢复，快照帧收日志。
//
// 帧体字段形状被 demo 里写死的字节数钉死，不要改名：
//   PUT      { txnId, name, val }
//   DEL      { txnId, name }
//   COMMIT   { txn, version }
//   SNAPSHOT { version, kv: { name: [[version, value], ...] }, keys }

import { createMemoryLog } from './log.js';
import { encodeFrame, decodeFrames } from './codec.js';
import { KVError } from './errors.js';

export const DEFAULTS = {
  maxValueBytes: 262144, // 单个 value 的 UTF-8 字节上限
};

export function createStore(options = {}) {
  const log = options.log ?? createMemoryLog();
  const maxValueBytes = options.maxValueBytes ?? DEFAULTS.maxValueBytes;
  const now = options.now ?? (() => Date.now());

  // 内存状态：key -> [{ version, value }]，value 为 null 是墓碑。
  const data = new Map();
  let version = 0;
  let liveBytes = 0;

  // 事务只在当前进程内有效；提交/回滚后仍留在表里，好让后续操作报 ERR_TXN_CLOSED。
  const txns = new Map();
  let txnSeq = 0;

  const recovery = { reason: 'clean', frames: 0, droppedBytes: 0 };

  const fail = (code, message, details) => {
    throw new KVError(code, message, details);
  };

  const applyOp = (name, value, atVersion) => {
    let history = data.get(name);
    if (!history) {
      history = [];
      data.set(name, history);
    }
    history.push({ version: atVersion, value });
    if (value !== null) liveBytes += Buffer.byteLength(value, 'utf8');
  };

  // ---- 构造时就地重放 -------------------------------------------------

  const replay = () => {
    const buffer = log.bytes();
    const { frames, end, reason } = decodeFrames(buffer);
    if (end < buffer.length) {
      // 撕裂 / crc 坏帧：截到能用的位置，后续 append 还能接着写。
      log.truncate(end);
      recovery.reason = reason;
      recovery.droppedBytes = buffer.length - end;
    }

    // checkpoint 两步之间断电时，日志可能是"老前缀 + 已写完的 SNAPSHOT"。
    // 最后一帧 SNAPSHOT 之前的内容都已被它覆盖，从快照开始读即可。
    let start = 0;
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i].type === 'SNAPSHOT') {
        start = i;
        break;
      }
    }

    // 认下来的帧数：从快照帧（含）到末尾；没有快照就是全部完整帧。
    recovery.frames = frames.length - start;

    if (frames[start]?.type === 'SNAPSHOT') {
      const body = frames[start].body;
      for (const [name, entries] of Object.entries(body.kv ?? {})) {
        for (const [v, value] of entries) applyOp(name, value, v);
      }
      version = body.version ?? 0;
      start += 1;
    }

    // 事务序号要对所有认下来的完整帧取最大值——即使帧位于最后一张快照之前、
    // 或因坏帧被切掉（id 不会复用），恢复后开的新事务也接着这个号往下数。
    for (const { type, body } of frames) {
      const raw = type === 'PUT' || type === 'DEL' ? body.txnId : type === 'COMMIT' ? body.txn : null;
      const seq = Number(String(raw ?? '').replace(/^t-/, ''));
      if (Number.isInteger(seq)) txnSeq = Math.max(txnSeq, seq);
    }

    // 攒住每个事务的操作，只有见到它的 COMMIT 才认；没提交的一律丢。
    const pending = new Map();
    for (let i = start; i < frames.length; i++) {
      const { type, body } = frames[i];
      if (type === 'PUT' || type === 'DEL') {
        let group = pending.get(body.txnId);
        if (!group) {
          group = [];
          pending.set(body.txnId, group);
        }
        group.push({ name: body.name, value: type === 'PUT' ? body.val : null });
      } else if (type === 'COMMIT') {
        for (const op of pending.get(body.txn) ?? []) {
          applyOp(op.name, op.value, body.version);
        }
        version = Math.max(version, body.version);
        pending.delete(body.txn);
      }
    }
  };

  replay();

  // ---- 工具 -----------------------------------------------------------

  const assertKey = (key) => {
    if (typeof key !== 'string' || key.length === 0) {
      fail('ERR_BAD_KEY', 'key 必须是非空字符串');
    }
  };

  const resolveTxn = (ref) => {
    const id = typeof ref === 'string' ? ref : ref?.id;
    const txn = txns.get(id);
    if (!txn) fail('ERR_UNKNOWN_TXN', `不认识的事务：${id}`);
    if (txn.closed) fail('ERR_TXN_CLOSED', `事务已经结束：${id}`);
    return txn;
  };

  const assertVersion = (atVersion) => {
    if (!Number.isInteger(atVersion) || atVersion < 0 || atVersion > version) {
      fail('ERR_BAD_VERSION', `版本号必须是 0..${version} 的整数`);
    }
  };

  const entryAt = (name, atVersion) => {
    const history = data.get(name);
    if (!history) return null;
    let found = null;
    for (const entry of history) {
      if (entry.version <= atVersion) found = entry;
      else break;
    }
    return found;
  };

  const keysCount = () => {
    let count = 0;
    for (const entries of data.values()) {
      if (entries.length > 0 && entries[entries.length - 1].value !== null) count += 1;
    }
    return count;
  };

  const pendingTxns = () => {
    let count = 0;
    for (const txn of txns.values()) if (!txn.closed) count += 1;
    return count;
  };

  // ---- 事务与写入 ------------------------------------------------------

  const begin = () => {
    txnSeq += 1;
    const txn = { id: `t-${txnSeq}`, openedAt: now(), ops: 0, actions: [], closed: false };
    txns.set(txn.id, txn);
    return { id: txn.id, openedAt: txn.openedAt };
  };

  const set = (ref, key, value) => {
    const txn = resolveTxn(ref);
    assertKey(key);
    if (typeof value !== 'string') fail('ERR_BAD_VALUE', 'value 必须是字符串');
    const size = Buffer.byteLength(value, 'utf8');
    if (size > maxValueBytes) {
      fail('ERR_VALUE_TOO_LARGE', `value 超过 ${maxValueBytes} 字节`, { size, maxValueBytes });
    }
    // 先写日志，内存不动。
    log.append(encodeFrame('PUT', { txnId: txn.id, name: key, val: value }));
    txn.ops += 1;
    txn.actions.push({ name: key, value });
    return { txnId: txn.id, key, size };
  };

  const del = (ref, key) => {
    const txn = resolveTxn(ref);
    assertKey(key);
    log.append(encodeFrame('DEL', { txnId: txn.id, name: key }));
    txn.ops += 1;
    txn.actions.push({ name: key, value: null });
    return { txnId: txn.id, key };
  };

  const commit = (ref) => {
    const txn = resolveTxn(ref);
    version += 1;
    const committedVersion = version;
    const ops = txn.ops;
    // COMMIT 落日志之后才把操作应用到内存。
    log.append(encodeFrame('COMMIT', { txn: txn.id, version: committedVersion }));
    for (const action of txn.actions) applyOp(action.name, action.value, committedVersion);
    txn.closed = true;
    return { txnId: txn.id, version: committedVersion, ops, walBytes: log.size };
  };

  const rollback = (ref) => {
    const txn = resolveTxn(ref);
    const ops = txn.ops;
    // 一个字节都不写；已落下去的 PUT/DEL 没有 COMMIT，恢复时自然不认。
    txn.closed = true;
    return { txnId: txn.id, ops };
  };

  // ---- 快照读 ----------------------------------------------------------

  const get = (key, atVersion = version) => {
    assertKey(key);
    assertVersion(atVersion);
    const entry = entryAt(key, atVersion);
    if (!entry || entry.value === null) return null;
    return { key, value: entry.value, version: entry.version };
  };

  const scan = (prefix = '', atVersion = version) => {
    assertVersion(atVersion);
    const out = [];
    for (const name of [...data.keys()].sort()) {
      if (!name.startsWith(prefix)) continue;
      const entry = entryAt(name, atVersion);
      if (entry && entry.value !== null) {
        out.push({ key: name, value: entry.value, version: entry.version });
      }
    }
    return out;
  };

  const history = (key) => {
    assertKey(key);
    return (data.get(key) ?? []).map((entry) => ({ version: entry.version, value: entry.value }));
  };

  // ---- checkpoint ------------------------------------------------------

  const checkpoint = () => {
    if (pendingTxns() > 0) fail('ERR_PENDING_TXNS', '还有没提交的事务，先提交或回滚');
    const kv = {};
    for (const [name, entries] of data) {
      kv[name] = entries.map((entry) => [entry.version, entry.value]);
    }
    // 顺序钉死：先把快照帧追加到日志末尾，再丢掉它之前的部分。
    const { offset } = log.append(encodeFrame('SNAPSHOT', { version, kv, keys: keysCount() }));
    log.dropPrefix(offset);
    return { version, walBytes: log.size };
  };

  const stats = () => ({
    version,
    keys: keysCount(),
    entries: data.size,
    walBytes: log.size,
    liveBytes,
    pendingTxns: pendingTxns(),
    recovery: { ...recovery },
  });

  return { begin, set, del, commit, rollback, get, scan, history, checkpoint, stats };
}
