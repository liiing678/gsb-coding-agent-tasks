// 分片上传的会话引擎。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/session|store|restore）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）、哈希（lib/hash.js）
// 和字节仓库（lib/blobstore.js）都已经按 README 的《口径》和《API》两节写好了。
// 那些约定不要改，把这里补出来。

import { RelayError } from './errors.js';
import { sha256Hex } from './hash.js';
import { createMemoryBlobStore } from './blobstore.js';

export const DEFAULTS = {
  maxStoreBytes: 64 * 1024 * 1024, // 所有 blob 相加的存储上限
  ttlMs: 60 * 60 * 1000,           // open 的会话多久没人动就过期
  completedTtlMs: 5 * 60 * 1000,   // complete 的会话保留多久
};

const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_CHUNK_SIZE = 1048576;
const SNAPSHOT_VERSION = 1;

export class UploadRelay {
  constructor(options = {}) {
    this.store = options.store ?? createMemoryBlobStore();
    this.maxStoreBytes = options.maxStoreBytes ?? DEFAULTS.maxStoreBytes;
    this.ttlMs = options.ttlMs ?? DEFAULTS.ttlMs;
    this.completedTtlMs = options.completedTtlMs ?? DEFAULTS.completedTtlMs;
    this.now = options.now ?? Date.now;
    this.sessions = new Map(); // id -> 会话记录（只存 hash，不存字节）
    this.blobs = new Map();    // hash -> { size, refs: Set('会话id#下标') }
    this.seq = 0;
    this.nextId = 1;
    this.listeners = new Set();
  }

  create(input = {}) {
    const { name, size, chunkSize, fingerprint } = input;
    if (typeof name !== 'string' || name.length === 0) {
      throw new RelayError('ERR_BAD_REQUEST', 'name 得是非空字符串');
    }
    if (!Number.isInteger(size) || size < 0) {
      throw new RelayError('ERR_BAD_REQUEST', 'size 得是 >= 0 的整数');
    }
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) {
      throw new RelayError('ERR_BAD_REQUEST', 'chunkSize 得是 1..1048576 的整数');
    }
    if (typeof fingerprint !== 'string' || !HASH_RE.test(fingerprint)) {
      throw new RelayError('ERR_BAD_REQUEST', 'fingerprint 得是 64 位小写 hex');
    }
    let id = input.id;
    if (id !== undefined) {
      if (typeof id !== 'string' || id.length === 0 || this.sessions.has(id)) {
        throw new RelayError('ERR_BAD_REQUEST', `id 不可用: ${id}`);
      }
    } else {
      do {
        id = `u-${this.nextId++}`;
      } while (this.sessions.has(id));
    }
    const now = this.now();
    const session = {
      id,
      name,
      size,
      chunkSize,
      chunkCount: size === 0 ? 0 : Math.ceil(size / chunkSize),
      fingerprint,
      state: 'open',
      chunks: new Map(), // index -> 内容 hash
      createdAt: now,
      lastActivityAt: now,
      completedAt: 0,
    };
    this.sessions.set(id, session);
    this.emit('session-created', id, {
      size,
      chunkSize,
      chunkCount: session.chunkCount,
    });
    return this.describe(session);
  }

  putChunk(id, index, bytes, hash) {
    const session = this.getSession(id);
    if (session.state !== 'open') {
      throw new RelayError('ERR_NOT_OPEN', `会话 ${id} 状态是 ${session.state}`);
    }
    if (!Number.isInteger(index) || index < 0 || index >= session.chunkCount) {
      throw new RelayError('ERR_CHUNK_OUT_OF_RANGE', `下标越界: ${index}`);
    }
    const expected = this.expectedLength(session, index);
    const actual = bytes.length;
    if (actual !== expected) {
      throw new RelayError('ERR_CHUNK_SIZE', `这一片应该是 ${expected}B，来了 ${actual}B`, {
        expected,
        actual,
      });
    }
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
      throw new RelayError('ERR_BAD_HASH', 'hash 得是 64 位小写 hex');
    }
    const digest = sha256Hex(bytes);
    if (digest !== hash) {
      throw new RelayError('ERR_CHUNK_HASH_MISMATCH', '内容 sha256 和声明的 hash 对不上', {
        declared: hash,
        actual: digest,
      });
    }
    const stored = session.chunks.get(index);
    if (stored !== undefined) {
      if (stored === hash) {
        session.lastActivityAt = this.now();
        this.emit('chunk-redundant', id, { index, hash, size: actual });
        return { index, size: actual, hash, deduped: true };
      }
      throw new RelayError('ERR_CHUNK_CONFLICT', `第 ${index} 片已经收过别的内容`, { stored });
    }
    const deduped = this.blobs.has(hash);
    if (deduped) {
      this.emit('blob-reused', id, { hash, size: actual });
    } else {
      const storedBytes = this.storedBytes();
      if (storedBytes + actual > this.maxStoreBytes) {
        throw new RelayError('ERR_STORE_FULL', '存储配额不够', {
          needed: actual,
          storedBytes,
        });
      }
      this.store.put(hash, bytes);
      this.blobs.set(hash, { size: actual, refs: new Set() });
      this.emit('blob-stored', id, { hash, size: actual });
    }
    this.blobs.get(hash).refs.add(`${id}#${index}`);
    session.chunks.set(index, hash);
    session.lastActivityAt = this.now();
    this.emit('chunk-accepted', id, { index, hash, size: actual, deduped });
    return { index, size: actual, hash, deduped };
  }

  status(id) {
    return this.describe(this.getSession(id));
  }

  complete(id) {
    const session = this.getSession(id);
    if (session.state !== 'open') {
      throw new RelayError('ERR_NOT_OPEN', `会话 ${id} 状态是 ${session.state}`);
    }
    const missing = this.missingOf(session);
    if (missing.length > 0) {
      throw new RelayError('ERR_INCOMPLETE', `还差 ${missing.length} 片`, { missing });
    }
    const parts = [];
    for (let i = 0; i < session.chunkCount; i++) {
      parts.push(this.store.get(session.chunks.get(i)));
    }
    const file = Buffer.concat(parts);
    const digest = sha256Hex(file);
    if (digest !== session.fingerprint) {
      throw new RelayError('ERR_FINGERPRINT_MISMATCH', '整份文件 sha256 和 fingerprint 对不上', {
        actual: digest,
      });
    }
    session.state = 'complete';
    session.completedAt = this.now();
    this.emit('session-completed', id, { size: session.size, sha256: digest, name: session.name });
    return file;
  }

  abort(id) {
    const session = this.getSession(id);
    if (session.state !== 'open') {
      throw new RelayError('ERR_NOT_OPEN', `会话 ${id} 状态是 ${session.state}`);
    }
    session.state = 'aborted';
    this.emit('session-aborted', id);
    const freed = this.releaseRefs(session);
    return { uploadId: id, freed };
  }

  sweep() {
    const now = this.now();
    const expired = [];
    const released = [];
    for (const session of [...this.sessions.values()]) {
      if (session.state === 'open' && now - session.lastActivityAt >= this.ttlMs) {
        session.state = 'expired';
        this.emit('session-expired', session.id, { idleMs: now - session.lastActivityAt });
        released.push(...this.releaseRefs(session));
        expired.push(session.id);
      } else if (
        session.state === 'complete' &&
        now - session.completedAt >= this.completedTtlMs
      ) {
        this.sessions.delete(session.id);
        this.emit('session-released', session.id, { size: session.size });
        released.push(...this.releaseRefs(session));
      }
    }
    return { expired, released };
  }

  stats() {
    let openSessions = 0;
    let logicalBytes = 0;
    for (const session of this.sessions.values()) {
      if (session.state === 'open') openSessions += 1;
      if (session.state === 'open' || session.state === 'complete') {
        logicalBytes += this.receivedBytesOf(session);
      }
    }
    const storedBytes = this.storedBytes();
    return {
      sessions: this.sessions.size,
      openSessions,
      blobs: this.blobs.size,
      storedBytes,
      logicalBytes,
      savedBytes: logicalBytes - storedBytes,
    };
  }

  snapshot() {
    return {
      version: SNAPSHOT_VERSION,
      seq: this.seq,
      nextId: this.nextId,
      sessions: [...this.sessions.values()].map((session) => ({
        id: session.id,
        name: session.name,
        size: session.size,
        chunkSize: session.chunkSize,
        fingerprint: session.fingerprint,
        state: session.state,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        completedAt: session.completedAt,
        chunks: [...session.chunks.entries()],
      })),
      blobs: [...this.blobs.entries()].map(([hash, blob]) => ({
        hash,
        size: blob.size,
        refs: [...blob.refs],
        bytes: this.store.get(hash).toString('base64'),
      })),
    };
  }

  restore(snapshot) {
    if (!snapshot || snapshot.version !== SNAPSHOT_VERSION) {
      throw new RelayError('ERR_BAD_SNAPSHOT', '快照版本不认识');
    }
    this.sessions.clear();
    this.blobs.clear();
    this.seq = snapshot.seq;
    this.nextId = snapshot.nextId;
    for (const raw of snapshot.sessions) {
      this.sessions.set(raw.id, {
        id: raw.id,
        name: raw.name,
        size: raw.size,
        chunkSize: raw.chunkSize,
        chunkCount: raw.size === 0 ? 0 : Math.ceil(raw.size / raw.chunkSize),
        fingerprint: raw.fingerprint,
        state: raw.state,
        chunks: new Map(raw.chunks),
        createdAt: raw.createdAt,
        lastActivityAt: raw.lastActivityAt,
        completedAt: raw.completedAt,
      });
    }
    for (const raw of snapshot.blobs) {
      this.store.put(raw.hash, Buffer.from(raw.bytes, 'base64'));
      this.blobs.set(raw.hash, { size: raw.size, refs: new Set(raw.refs) });
    }
    return this;
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, uploadId, fields = {}) {
    const event = { seq: ++this.seq, type, uploadId, ...fields };
    for (const fn of this.listeners) fn(event);
  }

  getSession(id) {
    const session = this.sessions.get(id);
    if (!session) {
      throw new RelayError('ERR_UNKNOWN_UPLOAD', `不认识的会话: ${id}`);
    }
    return session;
  }

  expectedLength(session, index) {
    return index === session.chunkCount - 1
      ? session.size - index * session.chunkSize
      : session.chunkSize;
  }

  missingOf(session) {
    const missing = [];
    for (let i = 0; i < session.chunkCount; i++) {
      if (!session.chunks.has(i)) missing.push(i);
    }
    return missing;
  }

  receivedBytesOf(session) {
    let total = 0;
    for (const index of session.chunks.keys()) {
      total += this.expectedLength(session, index);
    }
    return total;
  }

  storedBytes() {
    let total = 0;
    for (const blob of this.blobs.values()) total += blob.size;
    return total;
  }

  describe(session) {
    const received = [...session.chunks.keys()].sort((a, b) => a - b);
    return {
      id: session.id,
      name: session.name,
      size: session.size,
      chunkSize: session.chunkSize,
      chunkCount: session.chunkCount,
      state: session.state,
      fingerprint: session.fingerprint,
      received,
      missing: this.missingOf(session),
      receivedBytes: this.receivedBytesOf(session),
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      completedAt: session.completedAt,
    };
  }

  // 释放会话占着的全部引用；引用清零的 blob 真删字节，返回删掉的 hash。
  releaseRefs(session) {
    const freed = [];
    const entries = [...session.chunks.entries()].sort((a, b) => a[0] - b[0]);
    session.chunks.clear();
    for (const [index, hash] of entries) {
      const blob = this.blobs.get(hash);
      if (!blob) continue;
      blob.refs.delete(`${session.id}#${index}`);
      if (blob.refs.size === 0) {
        this.store.delete(hash);
        this.blobs.delete(hash);
        this.emit('blob-released', session.id, { hash, size: blob.size });
        freed.push(hash);
      }
    }
    return freed;
  }
}
