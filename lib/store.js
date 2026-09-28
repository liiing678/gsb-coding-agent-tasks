// 内存 MVCC 事务存储。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/txn.test.js、test/store.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import { MvccError } from './errors.js';

export const DEFAULTS = {
  maxKeyLength: 256,
};

Object.freeze(DEFAULTS);

export function createStore(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new MvccError('ERR_BAD_CONFIG', '配置必须是对象');
  }

  const maxKeyLength = config.maxKeyLength === undefined
    ? DEFAULTS.maxKeyLength
    : config.maxKeyLength;

  if (!Number.isInteger(maxKeyLength) || maxKeyLength <= 0) {
    throw new MvccError('ERR_BAD_CONFIG', 'maxKeyLength 必须是正整数');
  }

  let commitTs = 0;
  let nextTxnId = 0;
  let commits = 0;
  let aborts = 0;
  let conflicts = 0;
  let collected = 0;

  const versionsByKey = new Map();
  const activeTxns = new Map();

  function cloneValue(value) {
    try {
      return structuredClone(value);
    } catch {
      throw new MvccError('ERR_BAD_VALUE', '值无法深拷贝');
    }
  }

  function validateKey(key) {
    if (typeof key !== 'string' || key.length === 0 || key.length > maxKeyLength) {
      throw new MvccError('ERR_BAD_KEY', `key 必须是长度 1 到 ${maxKeyLength} 的字符串`);
    }
  }

  function validateRange(from, to) {
    if (
      (from !== undefined && typeof from !== 'string')
      || (to !== undefined && typeof to !== 'string')
      || (from !== undefined && to !== undefined && from > to)
    ) {
      throw new MvccError('ERR_BAD_RANGE', 'scan 区间必须是 [from, to)');
    }
  }

  function inRange(key, from, to) {
    if (from !== undefined && key < from) {
      return false;
    }
    if (to !== undefined && key >= to) {
      return false;
    }
    return true;
  }

  function visibleVersion(key, snapshot) {
    const versions = versionsByKey.get(key);
    if (!versions) {
      return undefined;
    }

    for (let i = versions.length - 1; i >= 0; i -= 1) {
      if (versions[i].commitTs <= snapshot) {
        return versions[i];
      }
    }
    return undefined;
  }

  function readVersion(version) {
    if (!version || version.deleted) {
      return undefined;
    }
    return cloneValue(version.value);
  }

  function scanVersions(snapshot, writes, from, to) {
    const keys = new Set(versionsByKey.keys());
    for (const key of writes.keys()) {
      keys.add(key);
    }

    const result = [];
    for (const key of Array.from(keys).sort()) {
      if (!inRange(key, from, to)) {
        continue;
      }

      const ownWrite = writes.get(key);
      if (ownWrite) {
        if (!ownWrite.deleted) {
          result.push({ key, value: cloneValue(ownWrite.value) });
        }
        continue;
      }

      const version = visibleVersion(key, snapshot);
      if (version && !version.deleted) {
        result.push({ key, value: cloneValue(version.value) });
      }
    }
    return result;
  }

  function begin() {
    const id = `txn-${nextTxnId += 1}`;
    const record = {
      id,
      snapshot: commitTs,
      state: 'active',
      writes: new Map(),
    };
    activeTxns.set(id, record);

    function assertActive() {
      if (record.state !== 'active') {
        throw new MvccError('ERR_TXN_CLOSED', `事务 ${record.id} 已经结束`);
      }
    }

    const txn = {
      id,
      get snapshot() {
        return record.snapshot;
      },
      get state() {
        return record.state;
      },

      get(key) {
        assertActive();
        validateKey(key);

        const ownWrite = record.writes.get(key);
        if (ownWrite) {
          return ownWrite.deleted ? undefined : cloneValue(ownWrite.value);
        }
        return readVersion(visibleVersion(key, record.snapshot));
      },

      put(key, value) {
        assertActive();
        validateKey(key);
        if (value === undefined) {
          throw new MvccError('ERR_BAD_VALUE', 'value 不能是 undefined');
        }

        record.writes.set(key, {
          deleted: false,
          value: cloneValue(value),
        });
      },

      delete(key) {
        assertActive();
        validateKey(key);
        record.writes.set(key, { deleted: true });
      },

      scan(from, to) {
        assertActive();
        validateRange(from, to);
        return scanVersions(record.snapshot, record.writes, from, to);
      },

      commit() {
        assertActive();

        const conflictingKeys = Array.from(record.writes.keys())
          .sort()
          .filter((key) => {
            const versions = versionsByKey.get(key);
            return versions && versions[versions.length - 1].commitTs > record.snapshot;
          });

        if (conflictingKeys.length > 0) {
          record.state = 'aborted';
          activeTxns.delete(record.id);
          record.writes.clear();
          conflicts += 1;
          aborts += 1;
          throw new MvccError(
            'ERR_CONFLICT',
            `事务 ${record.id} 与已提交事务存在写写冲突`,
            { txnId: record.id, keys: conflictingKeys },
          );
        }

        const versionTs = commitTs += 1;
        for (const [key, write] of record.writes) {
          let versions = versionsByKey.get(key);
          if (!versions) {
            versions = [];
            versionsByKey.set(key, versions);
          }

          versions.push({
            commitTs: versionTs,
            deleted: write.deleted,
            value: write.deleted ? undefined : write.value,
          });
        }

        const writeCount = record.writes.size;
        record.state = 'committed';
        activeTxns.delete(record.id);
        record.writes.clear();
        commits += 1;

        return { commitTs: versionTs, writes: writeCount };
      },

      abort() {
        if (record.state !== 'active') {
          return false;
        }

        record.state = 'aborted';
        activeTxns.delete(record.id);
        record.writes.clear();
        aborts += 1;
        return true;
      },
    };

    return txn;
  }

  function get(key) {
    validateKey(key);
    return readVersion(visibleVersion(key, commitTs));
  }

  function scan(from = undefined, to = undefined) {
    validateRange(from, to);
    return scanVersions(commitTs, new Map(), from, to);
  }

  function collect() {
    let removed = 0;

    for (const [key, versions] of versionsByKey) {
      const retainedIndexes = new Set([versions.length - 1]);

      for (const txn of activeTxns.values()) {
        for (let i = versions.length - 1; i >= 0; i -= 1) {
          if (versions[i].commitTs <= txn.snapshot) {
            retainedIndexes.add(i);
            break;
          }
        }
      }

      if (retainedIndexes.size < versions.length) {
        const keptVersions = versions.filter((_, index) => retainedIndexes.has(index));
        removed += versions.length - keptVersions.length;
        versionsByKey.set(key, keptVersions);
      }
    }

    collected += removed;
    return removed;
  }

  function stats() {
    let keys = 0;
    let versions = 0;

    for (const versionList of versionsByKey.values()) {
      versions += versionList.length;
      if (!versionList[versionList.length - 1].deleted) {
        keys += 1;
      }
    }

    return {
      commitTs,
      activeTxns: activeTxns.size,
      keys,
      versions,
      commits,
      aborts,
      conflicts,
      collected,
    };
  }

  return {
    begin,
    get,
    scan,
    collect,
    stats,
  };
}
