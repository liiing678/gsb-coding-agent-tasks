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

const SNAPSHOT_VERSION = 1;
const MAX_CHUNK_SIZE = 1024 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/;

const fail = (code, message, details = {}) => new RelayError(code, message, details);

const expectedLength = (session, index) =>
  Math.min(session.chunkSize, session.size - index * session.chunkSize);

const refKey = (id, index) => `${id}#${index}`;

export class UploadRelay {
  constructor(options = {}) {
    this.store = options.store ?? createMemoryBlobStore();
    this.maxStoreBytes = options.maxStoreBytes ?? DEFAULTS.maxStoreBytes;
    this.ttlMs = options.ttlMs ?? DEFAULTS.ttlMs;
    this.completedTtlMs = options.completedTtlMs ?? DEFAULTS.completedTtlMs;
    this.now = options.now ?? Date.now;
    this.sessions = new Map();
    this.refs = new Map();
    this.seq = 0;
    this.nextId = 1;
    this.listeners = new Set();
  }

  create(input) {
    const { name, size, chunkSize, fingerprint } = input;
    if (typeof name !== 'string' || name.length === 0) {
      throw fail('ERR_BAD_REQUEST', 'name 必须是非空字符串');
    }
    if (!Number.isInteger(size) || size < 0) {
      throw fail('ERR_BAD_REQUEST', 'size 必须是非负整数');
    }
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) {
      throw fail('ERR_BAD_REQUEST', `chunkSize 必须是 1..${MAX_CHUNK_SIZE} 的整数`);
    }
    if (typeof fingerprint !== 'string' || !HASH_RE.test(fingerprint)) {
      throw fail('ERR_BAD_REQUEST', 'fingerprint 必须是 64 位小写 hex');
    }

    let id;
    if (input.id !== undefined) {
      if (typeof input.id !== 'string' || input.id.length === 0) {
        throw fail('ERR_BAD_REQUEST', 'id 必须是非空字符串');
      }
      id = input.id;
      if (this.sessions.has(id)) {
        throw fail('ERR_BAD_REQUEST', `会话号 ${id} 已经存在`);
      }
    } else {
      id = `u-${this.nextId++}`;
    }

    const timestamp = this.now();
    const chunkCount = size === 0 ? 0 : Math.ceil(size / chunkSize);
    const session = {
      id,
      name,
      size,
      chunkSize,
      chunkCount,
      fingerprint,
      state: 'open',
      chunks: new Array(chunkCount).fill(null),
      createdAt: timestamp,
      lastActivityAt: timestamp,
      completedAt: 0,
    };
    this.sessions.set(id, session);
    this.emit('session-created', id, { size, chunkSize, chunkCount });
    return this.descriptor(session);
  }

  putChunk(id, index, bytes, hash) {
    const session = this.requireOpen(id);

    if (!Number.isInteger(index) || index < 0 || index >= session.chunkCount) {
      throw fail('ERR_CHUNK_OUT_OF_RANGE', `分片下标 ${index} 越界`, {
        index,
        chunkCount: session.chunkCount,
      });
    }

    const actualSize = bytes.length;
    const wantedSize = expectedLength(session, index);
    if (actualSize !== wantedSize) {
      throw fail('ERR_CHUNK_SIZE', `这一片应为 ${wantedSize} 字节，实际 ${actualSize} 字节`, {
        expected: wantedSize,
        actual: actualSize,
      });
    }

    if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
      throw fail('ERR_BAD_HASH', 'hash 必须是 64 位小写 hex', { hash });
    }

    const actualHash = sha256Hex(bytes);
    if (actualHash !== hash) {
      throw fail('ERR_CHUNK_HASH_MISMATCH', '片子内容的 sha256 和声明的 hash 对不上', {
        declared: hash,
        actual: actualHash,
      });
    }

    const storedHash = session.chunks[index];
    if (storedHash !== null) {
      if (storedHash === hash) {
        session.lastActivityAt = this.now();
        this.emit('chunk-redundant', id, { index, hash, size: actualSize });
        return { index, size: actualSize, hash, deduped: true };
      }
      throw fail('ERR_CHUNK_CONFLICT', `第 ${index} 片之前收过另一份内容`, {
        index,
        stored: storedHash,
      });
    }

    const alreadyStored = this.store.has(hash);
    if (!alreadyStored) {
      const storedBytes = this.store.totalBytes;
      if (storedBytes + actualSize > this.maxStoreBytes) {
        throw fail('ERR_STORE_FULL', `存储配额不足：需要 ${actualSize}B，现有 ${storedBytes}B`, {
          needed: actualSize,
          storedBytes,
        });
      }
      this.store.put(hash, bytes);
      this.emit('blob-stored', id, { hash, size: actualSize });
    } else {
      this.emit('blob-reused', id, { hash, size: actualSize });
    }

    session.chunks[index] = hash;
    session.lastActivityAt = this.now();
    let refs = this.refs.get(hash);
    if (!refs) {
      refs = new Set();
      this.refs.set(hash, refs);
    }
    refs.add(refKey(id, index));

    this.emit('chunk-accepted', id, { index, hash, size: actualSize, deduped: alreadyStored });
    return { index, size: actualSize, hash, deduped: alreadyStored };
  }

  status(id) {
    return this.descriptor(this.requireSession(id));
  }

  complete(id) {
    const session = this.requireOpen(id);

    const missing = [];
    session.chunks.forEach((chunkHash, idx) => {
      if (chunkHash === null) missing.push(idx);
    });
    if (missing.length > 0) {
      throw fail('ERR_INCOMPLETE', `还缺 ${missing.length} 片没收齐`, { missing });
    }

    const file = Buffer.concat(session.chunks.map((chunkHash) => this.store.get(chunkHash)));
    const sha = sha256Hex(file);
    if (sha !== session.fingerprint) {
      throw fail('ERR_FINGERPRINT_MISMATCH', '拼出来的整份文件 sha256 和 fingerprint 对不上', {
        expected: session.fingerprint,
        actual: sha,
      });
    }

    session.state = 'complete';
    session.completedAt = this.now();
    this.emit('session-completed', id, { size: session.size, sha256: sha, name: session.name });
    return file;
  }

  abort(id) {
    const session = this.requireOpen(id);
    session.state = 'aborted';
    this.emit('session-aborted', id, {});
    const freed = this.releaseRefs(session);
    return { uploadId: id, freed };
  }

  sweep() {
    const now = this.now();
    const expired = [];
    const released = [];

    for (const id of [...this.sessions.keys()]) {
      const session = this.sessions.get(id);
      if (session.state === 'open' && now - session.lastActivityAt >= this.ttlMs) {
        const idleMs = now - session.lastActivityAt;
        session.state = 'expired';
        this.emit('session-expired', id, { idleMs });
        expired.push(id);
        released.push(...this.releaseRefs(session));
      } else if (
        session.state === 'complete' &&
        now - session.completedAt >= this.completedTtlMs
      ) {
        const { size } = session;
        this.sessions.delete(id);
        this.emit('session-released', id, { size });
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
        session.chunks.forEach((chunkHash, index) => {
          if (chunkHash !== null) logicalBytes += expectedLength(session, index);
        });
      }
    }
    const storedBytes = this.store.totalBytes;
    return {
      sessions: this.sessions.size,
      openSessions,
      blobs: this.store.keys().length,
      storedBytes,
      logicalBytes,
      savedBytes: logicalBytes - storedBytes,
    };
  }

  snapshot() {
    const blobs = {};
    for (const hash of this.store.keys()) {
      blobs[hash] = this.store.get(hash).toString('base64');
    }
    return {
      version: SNAPSHOT_VERSION,
      seq: this.seq,
      nextId: this.nextId,
      sessions: [...this.sessions.values()].map((session) => ({
        id: session.id,
        name: session.name,
        size: session.size,
        chunkSize: session.chunkSize,
        chunkCount: session.chunkCount,
        fingerprint: session.fingerprint,
        state: session.state,
        chunks: session.chunks.slice(),
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        completedAt: session.completedAt,
      })),
      blobs,
    };
  }

  restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || snapshot.version !== SNAPSHOT_VERSION) {
      throw fail('ERR_BAD_SNAPSHOT', '快照版本不认识');
    }

    for (const hash of this.store.keys()) this.store.delete(hash);
    this.sessions = new Map();
    this.refs = new Map();

    for (const [hash, base64] of Object.entries(snapshot.blobs ?? {})) {
      this.store.put(hash, Buffer.from(base64, 'base64'));
    }

    for (const raw of snapshot.sessions ?? []) {
      const chunks = new Array(raw.chunkCount).fill(null);
      for (let index = 0; index < raw.chunks.length; index += 1) {
        chunks[index] = raw.chunks[index];
      }
      const session = {
        id: raw.id,
        name: raw.name,
        size: raw.size,
        chunkSize: raw.chunkSize,
        chunkCount: raw.chunkCount,
        fingerprint: raw.fingerprint,
        state: raw.state,
        chunks,
        createdAt: raw.createdAt,
        lastActivityAt: raw.lastActivityAt,
        completedAt: raw.completedAt,
      };
      this.sessions.set(session.id, session);
      chunks.forEach((hash, index) => {
        if (hash === null) return;
        let refs = this.refs.get(hash);
        if (!refs) {
          refs = new Set();
          this.refs.set(hash, refs);
        }
        refs.add(refKey(session.id, index));
      });
    }

    this.seq = snapshot.seq ?? 0;
    this.nextId = snapshot.nextId ?? 1;
    return this;
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, uploadId, fields) {
    const event = { seq: (this.seq += 1), type, uploadId, ...fields };
    for (const listener of this.listeners) listener(event);
    return event;
  }

  requireSession(id) {
    const session = this.sessions.get(id);
    if (!session) throw fail('ERR_UNKNOWN_UPLOAD', `不认识的会话号 ${id}`, { id });
    return session;
  }

  requireOpen(id) {
    const session = this.requireSession(id);
    if (session.state !== 'open') {
      throw fail('ERR_NOT_OPEN', `会话 ${id} 处于 ${session.state}，不能再收片`, {
        id,
        state: session.state,
      });
    }
    return session;
  }

  releaseRefs(session) {
    const freed = [];
    session.chunks.forEach((hash, index) => {
      if (hash === null) return;
      session.chunks[index] = null;
      const refs = this.refs.get(hash);
      if (!refs) return;
      refs.delete(refKey(session.id, index));
      if (refs.size === 0) {
        this.refs.delete(hash);
        const size = this.store.get(hash)?.length ?? 0;
        this.store.delete(hash);
        this.emit('blob-released', session.id, { hash, size });
        freed.push(hash);
      }
    });
    return freed;
  }

  descriptor(session) {
    const received = [];
    const missing = [];
    let receivedBytes = 0;
    session.chunks.forEach((hash, index) => {
      if (hash === null) {
        missing.push(index);
      } else {
        received.push(index);
        receivedBytes += expectedLength(session, index);
      }
    });
    return {
      id: session.id,
      name: session.name,
      size: session.size,
      chunkSize: session.chunkSize,
      chunkCount: session.chunkCount,
      state: session.state,
      fingerprint: session.fingerprint,
      received,
      missing,
      receivedBytes,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      completedAt: session.completedAt,
    };
  }
}
