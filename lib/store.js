// 内存 MVCC 事务存储。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/txn.test.js、test/store.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import { MvccError } from './errors.js';

export const DEFAULTS = {
  maxKeyLength: 256,
};

export function createStore(config = {}) {
  if (config === undefined) config = {};
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new MvccError('ERR_BAD_CONFIG', '配置必须是对象');
  }
  const maxKeyLength = config.maxKeyLength === undefined
    ? DEFAULTS.maxKeyLength
    : config.maxKeyLength;
  if (!Number.isInteger(maxKeyLength) || maxKeyLength <= 0) {
    throw new MvccError('ERR_BAD_CONFIG', 'maxKeyLength 必须是正整数');
  }

  // key -> 版本数组，按 commitTs 升序；墓碑版本 { ts, deleted: true }。
  const data = new Map();
  const active = new Set();
  let commitTs = 0;
  let txnSeq = 0;
  let commits = 0;
  let aborts = 0;
  let conflicts = 0;
  let collected = 0;

  function checkKey(key) {
    if (typeof key !== 'string' || key.length === 0 || key.length > maxKeyLength) {
      throw new MvccError('ERR_BAD_KEY', `key 必须是长度 1 ~ ${maxKeyLength} 的字符串`);
    }
  }

  function checkRange(from, to) {
    if (from !== undefined && typeof from !== 'string') {
      throw new MvccError('ERR_BAD_RANGE', 'from 必须是字符串');
    }
    if (to !== undefined && typeof to !== 'string') {
      throw new MvccError('ERR_BAD_RANGE', 'to 必须是字符串');
    }
    if (from !== undefined && to !== undefined && from > to) {
      throw new MvccError('ERR_BAD_RANGE', '区间必须满足 from <= to');
    }
  }

  function clone(value) {
    try {
      return structuredClone(value);
    } catch {
      throw new MvccError('ERR_BAD_VALUE', 'value 无法深拷贝');
    }
  }

  // 版本数组按 ts 升序，返回 ts <= snapshot 的最后一版；没有就 undefined。
  function visibleAt(versions, snapshot) {
    for (let i = versions.length - 1; i >= 0; i--) {
      if (versions[i].ts <= snapshot) return versions[i];
    }
    return undefined;
  }

  // 合并快照可见版本与事务自己的写集，得到一份 key -> value 的视图（墓碑不入表）。
  function snapshotView(snapshot, writeSet) {
    const view = new Map();
    for (const [key, versions] of data) {
      const version = visibleAt(versions, snapshot);
      if (version !== undefined && !version.deleted) view.set(key, version.value);
    }
    if (writeSet !== null) {
      for (const [key, write] of writeSet) {
        if (write.deleted) view.delete(key);
        else view.set(key, write.value);
      }
    }
    return view;
  }

  function filterRange(view, from, to) {
    const keys = [...view.keys()]
      .filter((key) => (from === undefined || key >= from) && (to === undefined || key < to))
      .sort();
    return keys.map((key) => ({ key, value: clone(view.get(key)) }));
  }

  function begin() {
    const txn = {
      id: `txn-${++txnSeq}`,
      snapshot: commitTs,
      state: 'active',
      writeSet: new Map(), // key -> { deleted } 或 { value（已是拷贝） }
    };
    active.add(txn);

    function ensureActive() {
      if (txn.state !== 'active') {
        throw new MvccError('ERR_TXN_CLOSED', `事务 ${txn.id} 已经结束`);
      }
    }

    function get(key) {
      ensureActive();
      checkKey(key);
      const own = txn.writeSet.get(key);
      if (own !== undefined) {
        return own.deleted ? undefined : clone(own.value);
      }
      const versions = data.get(key);
      if (versions === undefined) return undefined;
      const version = visibleAt(versions, txn.snapshot);
      if (version === undefined || version.deleted) return undefined;
      return clone(version.value);
    }

    function put(key, value) {
      ensureActive();
      checkKey(key);
      if (value === undefined) {
        throw new MvccError('ERR_BAD_VALUE', 'value 不能是 undefined，删除请用 delete');
      }
      txn.writeSet.set(key, { deleted: false, value: clone(value) });
    }

    function remove(key) {
      ensureActive();
      checkKey(key);
      txn.writeSet.set(key, { deleted: true });
    }

    function scan(from, to) {
      ensureActive();
      checkRange(from, to);
      return filterRange(snapshotView(txn.snapshot, txn.writeSet), from, to);
    }

    function commit() {
      ensureActive();
      const conflicted = [];
      for (const key of txn.writeSet.keys()) {
        const versions = data.get(key);
        const latest = versions === undefined ? undefined : versions[versions.length - 1];
        if (latest !== undefined && latest.ts > txn.snapshot) conflicted.push(key);
      }
      if (conflicted.length > 0) {
        txn.state = 'aborted';
        txn.writeSet = null;
        active.delete(txn);
        conflicts += 1;
        aborts += 1;
        conflicted.sort();
        throw new MvccError(
          'ERR_CONFLICT',
          `事务 ${txn.id} 与其他事务写写冲突`,
          { txnId: txn.id, keys: conflicted },
        );
      }

      commitTs += 1;
      for (const [key, write] of txn.writeSet) {
        const version = write.deleted
          ? { ts: commitTs, deleted: true }
          : { ts: commitTs, value: write.value };
        const versions = data.get(key);
        if (versions === undefined) data.set(key, [version]);
        else versions.push(version);
      }
      const writes = txn.writeSet.size;
      txn.state = 'committed';
      txn.writeSet = null;
      active.delete(txn);
      commits += 1;
      return { commitTs, writes };
    }

    function abort() {
      if (txn.state !== 'active') return false;
      txn.state = 'aborted';
      txn.writeSet = null;
      active.delete(txn);
      aborts += 1;
      return true;
    }

    return {
      id: txn.id,
      get snapshot() { return txn.snapshot; },
      get state() { return txn.state; },
      get,
      put,
      delete: remove,
      scan,
      commit,
      abort,
    };
  }

  function get(key) {
    checkKey(key);
    const versions = data.get(key);
    if (versions === undefined) return undefined;
    const latest = versions[versions.length - 1];
    if (latest.deleted) return undefined;
    return clone(latest.value);
  }

  function scan(from, to) {
    checkRange(from, to);
    return filterRange(snapshotView(commitTs, null), from, to);
  }

  function collect() {
    let removed = 0;
    for (const [key, versions] of data) {
      const keep = new Set([versions.length - 1]); // 最新版本（含墓碑）永远留着
      for (const txn of active) {
        let index = -1;
        for (let i = versions.length - 1; i >= 0; i--) {
          if (versions[i].ts <= txn.snapshot) {
            index = i;
            break;
          }
        }
        if (index !== -1) keep.add(index);
      }
      if (keep.size < versions.length) {
        const next = versions.filter((_, index) => keep.has(index));
        removed += versions.length - next.length;
        data.set(key, next);
      }
    }
    collected += removed;
    return removed;
  }

  function stats() {
    let keys = 0;
    let versions = 0;
    for (const versionList of data.values()) {
      versions += versionList.length;
      if (!versionList[versionList.length - 1].deleted) keys += 1;
    }
    return {
      commitTs,
      activeTxns: active.size,
      keys,
      versions,
      commits,
      aborts,
      conflicts,
      collected,
    };
  }

  return { begin, get, scan, collect, stats };
}
