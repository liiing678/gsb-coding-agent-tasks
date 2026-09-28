// 内容定义分块的去重存储。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/chunk.test.js、test/refs.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import crypto from 'node:crypto';
import { DedupError } from './errors.js';

export const DEFAULTS = {
  minBytes: 64,
  maxBytes: 256,
  windowBytes: 16,
  boundaryBits: 6,
};

const BASE = 7919;

function fail(code, message, details = {}) {
  throw new DedupError(code, message, details);
}

function asArgs(arg) {
  if (arg === null || typeof arg !== 'object') {
    fail('ERR_BAD_ARGS', '接口参数必须是一个对象');
  }
  return arg;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function asBytes(value) {
  // Buffer 也是 Uint8Array 的子类，一并认下。
  if (!(value instanceof Uint8Array)) {
    fail('ERR_BAD_ARGS', 'data 必须是 Uint8Array 或 Buffer');
  }
  return value;
}

function isInt(value) {
  return Number.isInteger(value);
}

function resolveConfig(config) {
  if (config === null || typeof config !== 'object') {
    fail('ERR_BAD_CONFIG', 'config 必须是一个对象');
  }
  const resolved = {
    minBytes: config.minBytes ?? DEFAULTS.minBytes,
    maxBytes: config.maxBytes ?? DEFAULTS.maxBytes,
    windowBytes: config.windowBytes ?? DEFAULTS.windowBytes,
    boundaryBits: config.boundaryBits ?? DEFAULTS.boundaryBits,
  };
  if (
    !isInt(resolved.minBytes) || resolved.minBytes < 1 ||
    !isInt(resolved.maxBytes) || resolved.maxBytes < resolved.minBytes ||
    !isInt(resolved.windowBytes) || resolved.windowBytes < 1 ||
    !isInt(resolved.boundaryBits) || resolved.boundaryBits < 1 || resolved.boundaryBits > 24
  ) {
    fail('ERR_BAD_CONFIG', 'minBytes / maxBytes / windowBytes / boundaryBits 不合法');
  }
  if ('clock' in config && typeof config.clock !== 'function') {
    fail('ERR_BAD_CONFIG', 'clock 必须是函数');
  }
  if ('clock' in config) {
    resolved.clock = config.clock;
  }
  return resolved;
}

// 滚动哈希切块。每一块都从 h = 0 重新攒，切点只看这一块自己的字节；
// 所有运算都是 32 位无符号回绕（>>> 0）。
function cutChunks(data, cfg) {
  const { minBytes, maxBytes, windowBytes, boundaryBits } = cfg;
  const mask = 2 ** boundaryBits - 1;
  let pow = 1;
  for (let i = 0; i < windowBytes; i += 1) {
    pow = Math.imul(pow, BASE) >>> 0;
  }

  const pieces = [];
  let start = 0;
  let h = 0;

  for (let i = 0; i < data.length; i += 1) {
    h = (((h * BASE) >>> 0) + data[i]) >>> 0;
    if (i - start >= windowBytes) {
      h = (h - Math.imul(data[i - windowBytes], pow)) >>> 0;
    }

    const size = i + 1 - start;
    const hitBoundary = size >= minBytes && (h & mask) === mask;
    const hitMax = size >= maxBytes;
    if (hitBoundary || hitMax) {
      pieces.push({ start, size });
      start = i + 1;
      h = 0;
    }
  }

  if (start < data.length) {
    pieces.push({ start, size: data.length - start });
  }

  return pieces;
}

export function createDedupStore(config = {}) {
  const cfg = resolveConfig(config);

  // hash -> { hash, data(Buffer 拷贝), refs }
  const blocks = new Map();
  // id -> { id, size, chunkHashes: [hash, ...]（同一块出现两次也记两次） }
  const objects = new Map();
  // name -> { name, ids: [id, ...]（去重，保持出现顺序） }
  const snapshots = new Map();
  let logicalBytes = 0;

  function describeChunks(data) {
    return cutChunks(data, cfg).map((piece) => {
      const hash = crypto
        .createHash('sha256')
        .update(data.subarray(piece.start, piece.start + piece.size))
        .digest('hex');
      return {
        offset: piece.start,
        size: piece.size,
        hash,
      };
    });
  }

  function pinningSnapshots(id) {
    const names = [];
    for (const { name, ids } of snapshots.values()) {
      if (ids.includes(id)) {
        names.push(name);
      }
    }
    return names.sort();
  }

  function storedBytes() {
    let total = 0;
    for (const block of blocks.values()) {
      total += block.data.length;
    }
    return total;
  }

  function chunk(data) {
    asBytes(data);
    return describeChunks(data);
  }

  function putObject(arg) {
    const { id, data } = asArgs(arg);
    if (!nonEmptyString(id)) {
      fail('ERR_BAD_ARGS', 'id 必须是非空字符串');
    }
    asBytes(data);
    if (objects.has(id)) {
      fail('ERR_DUPLICATE_OBJECT', `对象 ${id} 已经存在`, { id });
    }

    const described = describeChunks(data);
    let newChunks = 0;
    const chunkHashes = [];
    for (const piece of described) {
      chunkHashes.push(piece.hash);
      const existing = blocks.get(piece.hash);
      if (existing) {
        existing.refs += 1;
      } else {
        blocks.set(piece.hash, {
          hash: piece.hash,
          // 存拷贝：外面之后改数组动不到库里这份。
          data: Buffer.from(data.subarray(piece.offset, piece.offset + piece.size)),
          refs: 1,
        });
        newChunks += 1;
      }
    }

    const size = data.length;
    objects.set(id, { id, size, chunkHashes });
    logicalBytes += size;

    return {
      id,
      size,
      chunks: described.length,
      newChunks,
      reusedChunks: described.length - newChunks,
    };
  }

  function getObject(arg) {
    const { id } = asArgs(arg);
    if (!nonEmptyString(id)) {
      fail('ERR_BAD_ARGS', 'id 必须是非空字符串');
    }
    const object = objects.get(id);
    if (!object) {
      fail('ERR_UNKNOWN_OBJECT', `对象 ${id} 没见过`, { id });
    }
    // 返回拷贝：每次都新拼一份 Buffer。
    return Buffer.concat(object.chunkHashes.map((hash) => blocks.get(hash).data));
  }

  function deleteObject(arg) {
    const { id } = asArgs(arg);
    if (!nonEmptyString(id)) {
      fail('ERR_BAD_ARGS', 'id 必须是非空字符串');
    }
    const object = objects.get(id);
    if (!object) {
      fail('ERR_UNKNOWN_OBJECT', `对象 ${id} 没见过`, { id });
    }

    const pinned = pinningSnapshots(id);
    if (pinned.length > 0) {
      fail('ERR_OBJECT_PINNED', `对象 ${id} 还被快照钉着`, { id, snapshots: pinned });
    }

    let unreferencedChunks = 0;
    for (const hash of object.chunkHashes) {
      const block = blocks.get(hash);
      block.refs -= 1;
      if (block.refs === 0) {
        unreferencedChunks += 1;
      }
    }

    objects.delete(id);
    logicalBytes -= object.size;

    return { id, size: object.size, unreferencedChunks };
  }

  function gc() {
    let chunks = 0;
    let bytes = 0;
    for (const [hash, block] of blocks) {
      if (block.refs === 0) {
        chunks += 1;
        bytes += block.data.length;
        blocks.delete(hash);
      }
    }
    return { chunks, bytes };
  }

  function createSnapshot(arg) {
    const { name, objects: ids } = asArgs(arg);
    if (!nonEmptyString(name)) {
      fail('ERR_BAD_ARGS', 'name 必须是非空字符串');
    }
    if (!Array.isArray(ids)) {
      fail('ERR_BAD_ARGS', 'objects 必须是对象 id 数组');
    }
    if (snapshots.has(name)) {
      fail('ERR_DUPLICATE_SNAPSHOT', `快照 ${name} 已经存在`, { name });
    }
    for (const id of ids) {
      if (!objects.has(id)) {
        fail('ERR_UNKNOWN_OBJECT', `对象 ${id} 没见过`, { id });
      }
    }

    // 重复的 id 只算一次，保留第一次出现的顺序。
    const uniqueIds = [...new Set(ids)];
    let bytes = 0;
    for (const id of uniqueIds) {
      bytes += objects.get(id).size;
    }
    snapshots.set(name, { name, ids: uniqueIds });

    return { name, objects: uniqueIds, bytes };
  }

  function restoreSnapshot(arg) {
    const { name } = asArgs(arg);
    if (!nonEmptyString(name)) {
      fail('ERR_BAD_ARGS', 'name 必须是非空字符串');
    }
    const snapshot = snapshots.get(name);
    if (!snapshot) {
      fail('ERR_UNKNOWN_SNAPSHOT', `快照 ${name} 没见过`, { name });
    }
    const listed = snapshot.ids.map((id) => {
      const object = objects.get(id);
      return { id, size: object.size };
    });
    const bytes = listed.reduce((sum, one) => sum + one.size, 0);

    return { name, objects: listed, bytes };
  }

  function dropSnapshot(arg) {
    const { name } = asArgs(arg);
    if (!nonEmptyString(name)) {
      fail('ERR_BAD_ARGS', 'name 必须是非空字符串');
    }
    if (!snapshots.has(name)) {
      fail('ERR_UNKNOWN_SNAPSHOT', `快照 ${name} 没见过`, { name });
    }
    snapshots.delete(name);
    return { name, dropped: true };
  }

  function stats() {
    const stored = storedBytes();
    return {
      objects: objects.size,
      snapshots: snapshots.size,
      chunks: blocks.size,
      logicalBytes,
      storedBytes: stored,
      dedupRatio: stored === 0 ? 1 : Number((logicalBytes / stored).toFixed(2)),
    };
  }

  function integrity() {
    const problems = [];

    const actualRefs = new Map();
    for (const { id, size, chunkHashes } of objects.values()) {
      let blockBytes = 0;
      for (const hash of chunkHashes) {
        const block = blocks.get(hash);
        if (!block) {
          problems.push(`对象 ${id} 引用了不存在的块 ${hash}`);
          continue;
        }
        blockBytes += block.data.length;
        actualRefs.set(hash, (actualRefs.get(hash) ?? 0) + 1);
      }
      if (blockBytes !== size) {
        problems.push(`对象 ${id} 的块长之和 ${blockBytes} 与 size ${size} 不一致`);
      }
    }

    for (const [hash, block] of blocks) {
      const actual = actualRefs.get(hash) ?? 0;
      if (block.refs !== actual) {
        problems.push(`块 ${hash} 的 refs ${block.refs} 与实际引用次数 ${actual} 不一致`);
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
