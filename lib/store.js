// 带预写日志的本地 KV。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/txn|recovery|snapshot）、演示脚本
// （scripts/demo.mjs）、帧编解码（lib/codec.js）、追加日志（lib/log.js）和错误码
// （lib/errors.js）都已经按 README 的《口径》和《API》两节写好了。
// 那些约定不要改，把这里补出来。

import { encodeFrame, decodeFrames } from './codec.js';
import { createMemoryLog } from './log.js';
import { KVError } from './errors.js';

export const DEFAULTS = {
  maxValueBytes: 262144, // 单个 value 的 UTF-8 字节上限
};

export function createStore(options = {}) {
  const log = options.log ?? createMemoryLog();
  const maxValueBytes = options.maxValueBytes ?? DEFAULTS.maxValueBytes;
  const now = options.now ?? Date.now;

  // 每个 key 的完整历史：[[version, value], ...] 按版本升序，删除记 value 为 null 的墓碑。
  const data = new Map();
  let version = 0;
  let txnSeq = 0;
  const txns = new Map(); // id -> { id, ops, closed }

  // 构造时就地重放日志：撕裂帧 / 校验不过的帧从那一帧开始全不要，日志截到能用的位置。
  const before = log.bytes();
  const decoded = decodeFrames(before);
  if (decoded.end < before.length) log.truncate(decoded.end);
  const recovery = {
    reason: decoded.reason,
    frames: decoded.frames.length,
    droppedBytes: before.length - decoded.end,
  };

  const pending = new Map(); // txid -> 还没被 COMMIT 认下的操作
  for (const frame of decoded.frames) {
    const body = frame.body;
    if (frame.type === 'PUT' || frame.type === 'DEL') {
      let ops = pending.get(body.txid);
      if (!ops) pending.set(body.txid, (ops = []));
      ops.push({ key: body.key, value: frame.type === 'PUT' ? body.value : null });
    } else if (frame.type === 'COMMIT') {
      for (const op of pending.get(body.txid) ?? []) applyOp(op.key, op.value, body.version);
      pending.delete(body.txid);
      if (body.version > version) version = body.version;
    } else if (frame.type === 'SNAPSHOT') {
      data.clear();
      for (const [key, history] of body.entries) data.set(key, history);
      pending.clear();
      if (body.version > version) version = body.version;
    }
  }

  function applyOp(key, value, atVersion) {
    let history = data.get(key);
    if (!history) data.set(key, (history = []));
    history.push([atVersion, value]);
  }

  function checkKey(key) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new KVError('ERR_BAD_KEY', 'key 必须是非空字符串', { key });
    }
  }

  function checkVersion(atVersion) {
    if (!Number.isInteger(atVersion) || atVersion < 0 || atVersion > version) {
      throw new KVError('ERR_BAD_VERSION', `版本号必须是 0..${version} 的整数`, { atVersion });
    }
  }

  function resolveTxn(txn) {
    const id = typeof txn === 'string' ? txn : txn?.id;
    const found = txns.get(id);
    if (!found) throw new KVError('ERR_UNKNOWN_TXN', `不认识的事务：${id}`, { txnId: id });
    if (found.closed) throw new KVError('ERR_TXN_CLOSED', `事务已经提交或回滚：${id}`, { txnId: id });
    return found;
  }

  function recordAt(history, atVersion) {
    let record = null;
    for (const entry of history) {
      if (entry[0] > atVersion) break;
      record = entry;
    }
    return record;
  }

  function begin() {
    const id = `t-${++txnSeq}`;
    const openedAt = now();
    txns.set(id, { id, ops: [], closed: false });
    return { id, openedAt };
  }

  function set(txn, key, value) {
    const found = resolveTxn(txn);
    checkKey(key);
    if (typeof value !== 'string') {
      throw new KVError('ERR_BAD_VALUE', 'value 必须是字符串', { key });
    }
    const size = Buffer.byteLength(value, 'utf8');
    if (size > maxValueBytes) {
      throw new KVError('ERR_VALUE_TOO_LARGE', `value 超过 ${maxValueBytes} 字节上限`, { key, size });
    }
    log.append(encodeFrame('PUT', { txid: found.id, key, value }));
    found.ops.push({ key, value });
    return { txnId: found.id, key, size };
  }

  function del(txn, key) {
    const found = resolveTxn(txn);
    checkKey(key);
    log.append(encodeFrame('DEL', { txid: found.id, key }));
    found.ops.push({ key, value: null });
    return { txnId: found.id, key };
  }

  function commit(txn) {
    const found = resolveTxn(txn);
    version += 1;
    log.append(encodeFrame('COMMIT', { txid: found.id, version }));
    found.closed = true;
    for (const op of found.ops) applyOp(op.key, op.value, version);
    return { txnId: found.id, version, ops: found.ops.length, walBytes: log.size };
  }

  function rollback(txn) {
    const found = resolveTxn(txn);
    found.closed = true;
    return { txnId: found.id, ops: found.ops.length };
  }

  function get(key, atVersion) {
    checkKey(key);
    const at = atVersion === undefined ? version : atVersion;
    checkVersion(at);
    const history = data.get(key);
    const record = history ? recordAt(history, at) : null;
    if (!record || record[1] === null) return null;
    return { key, value: record[1], version: record[0] };
  }

  function scan(prefix = '', atVersion) {
    const at = atVersion === undefined ? version : atVersion;
    checkVersion(at);
    const out = [];
    for (const [key, history] of data) {
      if (!key.startsWith(prefix)) continue;
      const record = recordAt(history, at);
      if (!record || record[1] === null) continue;
      out.push({ key, value: record[1], version: record[0] });
    }
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  }

  function history(key) {
    checkKey(key);
    return (data.get(key) ?? []).map(([at, value]) => ({ version: at, value }));
  }

  function checkpoint() {
    const open = [...txns.values()].filter((txn) => !txn.closed).length;
    if (open > 0) {
      throw new KVError('ERR_PENDING_TXNS', `还有 ${open} 个没提交的事务`, { pendingTxns: open });
    }
    // 顺序不能反：先把快照帧追加到日志末尾，再丢掉它前面的部分。
    const { offset } = log.append(encodeFrame('SNAPSHOT', { version, entries: [...data] }));
    log.dropPrefix(offset);
    return { version, walBytes: log.size };
  }

  function stats() {
    let keys = 0;
    let liveBytes = 0;
    for (const entries of data.values()) {
      if (entries[entries.length - 1][1] !== null) keys += 1;
      for (const [, value] of entries) {
        if (value !== null) liveBytes += Buffer.byteLength(value, 'utf8');
      }
    }
    return {
      version,
      keys,
      entries: data.size,
      walBytes: log.size,
      liveBytes,
      pendingTxns: [...txns.values()].filter((txn) => !txn.closed).length,
      recovery: { ...recovery },
    };
  }

  return { begin, set, del, commit, rollback, get, scan, history, checkpoint, stats };
}
