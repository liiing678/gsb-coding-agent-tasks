import test from 'node:test';
import assert from 'node:assert/strict';
import { UploadRelay } from '../lib/relay.js';
import { sha256Hex } from '../lib/hash.js';
import { createMemoryBlobStore } from '../lib/blobstore.js';

const bytes = (size, seed = 7) =>
  Buffer.from(Array.from({ length: size }, (_, i) => (seed + i * 37) & 0xff));

const upload = (relay, id, body, chunkSize) => {
  for (let i = 0; i * chunkSize < body.length; i++) {
    const part = body.subarray(i * chunkSize, (i + 1) * chunkSize);
    relay.putChunk(id, i, part, sha256Hex(part));
  }
};

test('内容一样的块只存一份，跨会话也是', () => {
  const store = createMemoryBlobStore();
  const relay = new UploadRelay({ store });
  const body = bytes(8);
  const a = relay.create({ name: 'a.bin', size: 8, chunkSize: 8, fingerprint: sha256Hex(body) });
  const b = relay.create({ name: 'b.bin', size: 8, chunkSize: 8, fingerprint: sha256Hex(body) });
  upload(relay, a.id, body, 8);
  upload(relay, b.id, body, 8);
  const stats = relay.stats();
  assert.equal(stats.blobs, 1);
  assert.equal(stats.storedBytes, 8);
  assert.equal(stats.logicalBytes, 16);
  assert.equal(stats.savedBytes, 8);
  assert.equal(store.totalBytes, 8);
});

test('引用没人要了就把字节真的删掉', () => {
  const store = createMemoryBlobStore();
  const relay = new UploadRelay({ store });
  const body = bytes(8);
  const hash = sha256Hex(body);
  const a = relay.create({ name: 'a.bin', size: 8, chunkSize: 8, fingerprint: hash });
  upload(relay, a.id, body, 8);
  assert.equal(store.has(hash), true);
  const events = [];
  relay.onEvent((ev) => events.push(ev.type));
  relay.abort(a.id);
  assert.equal(store.has(hash), false);
  assert.deepEqual(events, ['session-aborted', 'blob-released']);
  assert.equal(relay.stats().blobs, 0);
  assert.equal(relay.stats().storedBytes, 0);
});

test('两个会话共享一块内容，撤掉一个不影响另一个', () => {
  const relay = new UploadRelay();
  const body = bytes(8);
  const hash = sha256Hex(body);
  const a = relay.create({ name: 'a.bin', size: 8, chunkSize: 8, fingerprint: hash });
  const b = relay.create({ name: 'b.bin', size: 8, chunkSize: 8, fingerprint: hash });
  upload(relay, a.id, body, 8);
  upload(relay, b.id, body, 8);
  relay.abort(a.id);
  assert.equal(relay.stats().blobs, 1);
  const out = relay.complete(b.id);
  assert.equal(Buffer.compare(out, body), 0);
});

test('存储配额不够时拒收，而且什么都没写进去', () => {
  const store = createMemoryBlobStore();
  const relay = new UploadRelay({ store, maxStoreBytes: 6 });
  const body = bytes(8);
  const s = relay.create({ name: 'a.bin', size: 8, chunkSize: 8, fingerprint: sha256Hex(body) });
  let code = '';
  try {
    relay.putChunk(s.id, 0, body, sha256Hex(body));
  } catch (err) {
    code = err.code;
  }
  assert.equal(code, 'ERR_STORE_FULL');
  assert.equal(store.totalBytes, 0);
  assert.equal(relay.stats().blobs, 0);
  assert.deepEqual(relay.status(s.id).received, []);
});

test('事件按发生顺序同步发出来，seq 从 1 连着涨', () => {
  const relay = new UploadRelay();
  const seen = [];
  relay.onEvent((ev) => seen.push(ev));
  const body = bytes(8);
  const hash = sha256Hex(body);
  const s = relay.create({ name: 'a.bin', size: 8, chunkSize: 8, fingerprint: hash });
  relay.putChunk(s.id, 0, body, hash);
  relay.putChunk(s.id, 0, body, hash);
  relay.complete(s.id);
  assert.deepEqual(seen.map((ev) => ev.type), [
    'session-created',
    'blob-stored',
    'chunk-accepted',
    'chunk-redundant',
    'session-completed',
  ]);
  assert.deepEqual(seen.map((ev) => ev.seq), [1, 2, 3, 4, 5]);
  assert.equal(seen[1].hash, hash);
  assert.equal(seen[2].deduped, false);
  assert.equal(seen[4].sha256, hash);
});

test('长期没人管的会话会过期，收尾过的会话过了保留期就回收', () => {
  let clock = 1000;
  const store = createMemoryBlobStore();
  const relay = new UploadRelay({ store, now: () => clock, ttlMs: 100, completedTtlMs: 50 });
  const body = bytes(8);
  const hash = sha256Hex(body);
  const stale = relay.create({ name: 'stale.bin', size: 8, chunkSize: 8, fingerprint: hash });
  const done = relay.create({ name: 'done.bin', size: 8, chunkSize: 8, fingerprint: hash });
  relay.putChunk(stale.id, 0, body, hash);
  relay.putChunk(done.id, 0, body, hash);
  relay.complete(done.id);
  assert.equal(relay.stats().blobs, 1);

  clock = 1050;
  const first = relay.sweep();
  assert.deepEqual(first.expired, []);
  assert.deepEqual(first.released, []);
  let gone = '';
  try {
    relay.status(done.id);
  } catch (err) {
    gone = err.code;
  }
  assert.equal(gone, 'ERR_UNKNOWN_UPLOAD');
  assert.equal(store.totalBytes, 8);

  clock = 1100;
  const second = relay.sweep();
  assert.deepEqual(second.expired, [stale.id]);
  assert.deepEqual(second.released, [hash]);
  assert.equal(relay.status(stale.id).state, 'expired');
  assert.equal(store.totalBytes, 0);
  let code2 = '';
  try {
    relay.putChunk(stale.id, 0, body, hash);
  } catch (err) {
    code2 = err.code;
  }
  assert.equal(code2, 'ERR_NOT_OPEN');
});
