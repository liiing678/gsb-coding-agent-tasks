// 内容定义分块的去重存储：滑窗滚动哈希切块、按 sha256 认块、引用计数管回收、快照钉对象。
import { createHash } from 'node:crypto';
import { DedupError } from './errors.js';

export const DEFAULTS = {
  minBytes: 64,
  maxBytes: 256,
  windowBytes: 16,
  boundaryBits: 6,
};

const BASE = 7919;

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isBytes(value) {
  return value instanceof Uint8Array || Buffer.isBuffer(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function requireArgsObject(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new DedupError('ERR_BAD_ARGS', '需要一个参数对象');
  }
}

function requireId(args) {
  if (!isNonEmptyString(args.id)) {
    throw new DedupError('ERR_BAD_ARGS', 'id 必须是非空字符串');
  }
}

function requireName(args) {
  if (!isNonEmptyString(args.name)) {
    throw new DedupError('ERR_BAD_ARGS', 'name 必须是非空字符串');
  }
}

export function createDedupStore(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new DedupError('ERR_BAD_CONFIG', 'config 必须是对象');
  }
  const { minBytes, maxBytes, windowBytes, boundaryBits } = { ...DEFAULTS, ...config };
  if (config.clock !== undefined && typeof config.clock !== 'function') {
    throw new DedupError('ERR_BAD_CONFIG', 'clock 必须是函数');
  }
  if (!Number.isInteger(minBytes) || minBytes < 1) {
    throw new DedupError('ERR_BAD_CONFIG', 'minBytes 必须是 >= 1 的整数');
  }
  if (!Number.isInteger(maxBytes) || maxBytes < minBytes) {
    throw new DedupError('ERR_BAD_CONFIG', 'maxBytes 必须是 >= minBytes 的整数');
  }
  if (!Number.isInteger(windowBytes) || windowBytes < 1) {
    throw new DedupError('ERR_BAD_CONFIG', 'windowBytes 必须是 >= 1 的整数');
  }
  if (!Number.isInteger(boundaryBits) || boundaryBits < 1 || boundaryBits > 24) {
    throw new DedupError('ERR_BAD_CONFIG', 'boundaryBits 必须在 1..24');
  }

  const mask = (2 ** boundaryBits) - 1;
  let pow = 1;
  for (let k = 0; k < windowBytes; k += 1) {
    pow = (pow * BASE) >>> 0;
  }

  // hash -> { bytes: Buffer, size, refs }
  const chunks = new Map();
  // id -> { id, size, hashes: string[] }
  const objects = new Map();
  // name -> { name, objects: string[] }
  const snapshots = new Map();

  function chunk(data) {
    if (!isBytes(data)) {
      throw new DedupError('ERR_BAD_ARGS', 'data 必须是 Uint8Array 或 Buffer');
    }
    const pieces = [];
    let start = 0;
    let h = 0;
    for (let i = 0; i < data.length; i += 1) {
      h = (h * BASE + data[i]) >>> 0;
      if (i - start >= windowBytes) {
        h = (h - data[i - windowBytes] * pow) >>> 0;
      }
      const size = i + 1 - start;
      if ((size >= minBytes && (h & mask) === mask) || size >= maxBytes) {
        pieces.push({ offset: start, size, hash: sha256Hex(data.subarray(start, i + 1)) });
        start = i + 1;
        h = 0;
      }
    }
    if (start < data.length) {
      pieces.push({
        offset: start,
        size: data.length - start,
        hash: sha256Hex(data.subarray(start)),
      });
    }
    return pieces;
  }

  function getObjectRecord(id) {
    const record = objects.get(id);
    if (!record) {
      throw new DedupError('ERR_UNKNOWN_OBJECT', `对象不存在: ${id}`, { id });
    }
    return record;
  }

  function putObject(args) {
    requireArgsObject(args);
    requireId(args);
    if (!isBytes(args.data)) {
      throw new DedupError('ERR_BAD_ARGS', 'data 必须是 Uint8Array 或 Buffer');
    }
    const { id } = args;
    if (objects.has(id)) {
      throw new DedupError('ERR_DUPLICATE_OBJECT', `对象已存在: ${id}`, { id });
    }
    const data = Buffer.from(args.data); // 库里只存拷贝
    const pieces = chunk(data);
    let newChunks = 0;
    const hashes = [];
    for (const piece of pieces) {
      hashes.push(piece.hash);
      let entry = chunks.get(piece.hash);
      if (!entry) {
        entry = {
          bytes: Buffer.from(data.subarray(piece.offset, piece.offset + piece.size)),
          size: piece.size,
          refs: 0,
        };
        chunks.set(piece.hash, entry);
        newChunks += 1;
      }
      entry.refs += 1; // 同一个对象里同一块出现几次就加几次
    }
    objects.set(id, { id, size: data.length, hashes });
    return {
      id,
      size: data.length,
      chunks: pieces.length,
      newChunks,
      reusedChunks: pieces.length - newChunks,
    };
  }

  function getObject(args) {
    requireArgsObject(args);
    requireId(args);
    const record = getObjectRecord(args.id);
    return Buffer.concat(record.hashes.map((hash) => chunks.get(hash).bytes));
  }

  function deleteObject(args) {
    requireArgsObject(args);
    requireId(args);
    const record = getObjectRecord(args.id);
    const pinning = [...snapshots.values()]
      .filter((snap) => snap.objects.includes(record.id))
      .map((snap) => snap.name)
      .sort();
    if (pinning.length > 0) {
      throw new DedupError('ERR_OBJECT_PINNED', `对象被快照钉住: ${record.id}`, {
        id: record.id,
        snapshots: pinning,
      });
    }
    let unreferencedChunks = 0;
    for (const hash of record.hashes) {
      const entry = chunks.get(hash);
      entry.refs -= 1;
      if (entry.refs === 0) {
        unreferencedChunks += 1;
      }
    }
    objects.delete(record.id);
    return { id: record.id, size: record.size, unreferencedChunks };
  }

  function gc() {
    let sweptChunks = 0;
    let sweptBytes = 0;
    for (const [hash, entry] of chunks) {
      if (entry.refs === 0) {
        sweptChunks += 1;
        sweptBytes += entry.size;
        chunks.delete(hash);
      }
    }
    return { chunks: sweptChunks, bytes: sweptBytes };
  }

  function createSnapshot(args) {
    requireArgsObject(args);
    requireName(args);
    if (!Array.isArray(args.objects)) {
      throw new DedupError('ERR_BAD_ARGS', 'objects 必须是数组');
    }
    const { name } = args;
    if (snapshots.has(name)) {
      throw new DedupError('ERR_DUPLICATE_SNAPSHOT', `快照已存在: ${name}`, { name });
    }
    const ids = [...new Set(args.objects)]; // 重复的 id 只算一次
    let bytes = 0;
    for (const id of ids) {
      bytes += getObjectRecord(id).size;
    }
    snapshots.set(name, { name, objects: ids });
    return { name, objects: [...ids], bytes };
  }

  function getSnapshotRecord(name) {
    const record = snapshots.get(name);
    if (!record) {
      throw new DedupError('ERR_UNKNOWN_SNAPSHOT', `快照不存在: ${name}`, { name });
    }
    return record;
  }

  function restoreSnapshot(args) {
    requireArgsObject(args);
    requireName(args);
    const record = getSnapshotRecord(args.name);
    const listed = record.objects.map((id) => ({ id, size: objects.get(id).size }));
    return {
      name: record.name,
      objects: listed,
      bytes: listed.reduce((sum, one) => sum + one.size, 0),
    };
  }

  function dropSnapshot(args) {
    requireArgsObject(args);
    requireName(args);
    const record = getSnapshotRecord(args.name);
    snapshots.delete(record.name);
    return { name: record.name, dropped: true };
  }

  function stats() {
    let logicalBytes = 0;
    for (const record of objects.values()) {
      logicalBytes += record.size;
    }
    let storedBytes = 0;
    for (const entry of chunks.values()) {
      storedBytes += entry.size;
    }
    return {
      objects: objects.size,
      snapshots: snapshots.size,
      chunks: chunks.size,
      logicalBytes,
      storedBytes,
      dedupRatio: storedBytes === 0 ? 1 : Number((logicalBytes / storedBytes).toFixed(2)),
    };
  }

  function integrity() {
    const problems = [];
    const actualRefs = new Map();
    for (const record of objects.values()) {
      let summed = 0;
      for (const hash of record.hashes) {
        const entry = chunks.get(hash);
        if (!entry) {
          problems.push(`object ${record.id}: 引用了不存在的块 ${hash}`);
          continue;
        }
        summed += entry.size;
        actualRefs.set(hash, (actualRefs.get(hash) ?? 0) + 1);
      }
      if (summed !== record.size) {
        problems.push(`object ${record.id}: 块长之和 ${summed} != size ${record.size}`);
      }
    }
    for (const [hash, entry] of chunks) {
      const actual = actualRefs.get(hash) ?? 0;
      if (entry.refs !== actual) {
        problems.push(`chunk ${hash}: refs ${entry.refs} != 实际引用 ${actual}`);
      }
    }
    problems.sort();
    return { ok: problems.length === 0, problems };
  }

  return {
    chunk,
    putObject,
    getObject,
    deleteObject,
    gc,
    createSnapshot,
    restoreSnapshot,
    dropSnapshot,
    stats,
    integrity,
  };
}
