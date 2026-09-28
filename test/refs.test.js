import test from 'node:test';
import assert from 'node:assert/strict';
import { createDedupStore } from '../lib/dedupstore.js';

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'DedupError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

const SMALL = { minBytes: 8, maxBytes: 32, windowBytes: 4, boundaryBits: 3 };

function bytes(length, seed = 1) {
  const out = Buffer.alloc(length);
  let state = (seed >>> 0) || 1;
  for (let i = 0; i < length; i += 1) {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    out[i] = state & 0xff;
  }
  return out;
}

test('还有别人引用着的块，删掉一个对象之后不能被回收', () => {
  const store = createDedupStore(SMALL);
  const shared = bytes(200, 3);
  const prefix = bytes(10, 8);
  store.putObject({ id: 'a', data: shared });
  store.putObject({ id: 'b', data: Buffer.concat([prefix, shared]) });
  const chunksBefore = store.stats().chunks;
  const removed = store.deleteObject({ id: 'a' });
  assert.equal(removed.id, 'a');
  const swept = store.gc();
  assert.equal(swept.chunks < chunksBefore, true);        // b 还在用的那些块留下来了
  assert.equal(swept.chunks > 0, true);                   // 只被 a 引用的那几块被收走
  assert.equal(store.stats().chunks, chunksBefore - swept.chunks);
  assert.deepEqual(store.getObject({ id: 'b' }), Buffer.concat([prefix, shared]));
});

test('没人引用的块由 gc 收走，收完 stats 也对得上', () => {
  const store = createDedupStore(SMALL);
  store.putObject({ id: 'a', data: bytes(300, 4) });
  const before = store.stats();
  const removed = store.deleteObject({ id: 'a' });
  assert.equal(removed.unreferencedChunks > 0, true);
  const swept = store.gc();
  assert.equal(swept.chunks, before.chunks);
  assert.equal(swept.bytes, before.storedBytes);
  assert.deepEqual(store.stats(), {
    objects: 0, snapshots: 0, chunks: 0, logicalBytes: 0, storedBytes: 0, dedupRatio: 1,
  });
  expectError(() => store.getObject({ id: 'a' }), 'ERR_UNKNOWN_OBJECT');
});

test('被快照钉住的对象删不掉，快照撤了才能删', () => {
  const store = createDedupStore(SMALL);
  store.putObject({ id: 'a', data: bytes(120, 6) });
  store.putObject({ id: 'b', data: bytes(120, 7) });
  assert.deepEqual(store.createSnapshot({ name: 'nightly', objects: ['a'] }), {
    name: 'nightly', objects: ['a'], bytes: 120,
  });
  const err = expectError(() => store.deleteObject({ id: 'a' }), 'ERR_OBJECT_PINNED');
  assert.deepEqual(err.details.snapshots, ['nightly']);
  assert.deepEqual(store.dropSnapshot({ name: 'nightly' }), { name: 'nightly', dropped: true });
  assert.equal(store.deleteObject({ id: 'a' }).id, 'a');
  assert.equal(store.deleteObject({ id: 'b' }).id, 'b');
});

test('restoreSnapshot 把快照里的对象和大小列出来', () => {
  const store = createDedupStore(SMALL);
  store.putObject({ id: 'a', data: bytes(120, 6) });
  store.putObject({ id: 'b', data: bytes(80, 7) });
  store.createSnapshot({ name: 's1', objects: ['a', 'b'] });
  assert.deepEqual(store.restoreSnapshot({ name: 's1' }), {
    name: 's1',
    objects: [{ id: 'a', size: 120 }, { id: 'b', size: 80 }],
    bytes: 200,
  });
  expectError(() => store.createSnapshot({ name: 's1', objects: [] }), 'ERR_DUPLICATE_SNAPSHOT');
  expectError(() => store.createSnapshot({ name: 's2', objects: ['nope'] }), 'ERR_UNKNOWN_OBJECT');
  expectError(() => store.restoreSnapshot({ name: 'nope' }), 'ERR_UNKNOWN_SNAPSHOT');
  expectError(() => store.dropSnapshot({ name: 'nope' }), 'ERR_UNKNOWN_SNAPSHOT');
});

test('integrity 对着引用计数核一遍', () => {
  const store = createDedupStore(SMALL);
  const shared = bytes(200, 3);
  store.putObject({ id: 'a', data: shared });
  store.putObject({ id: 'b', data: Buffer.concat([bytes(10, 8), shared]) });
  assert.deepEqual(store.integrity(), { ok: true, problems: [] });
  store.deleteObject({ id: 'a' });
  assert.deepEqual(store.integrity(), { ok: true, problems: [] });
});

test('统计口径：去重比按逻辑字节除以实际落盘字节', () => {
  const store = createDedupStore(SMALL);
  const block = bytes(400, 7);
  store.putObject({ id: 'a', data: block });
  store.putObject({ id: 'b', data: Buffer.concat([block, block]) });
  const stats = store.stats();
  assert.equal(stats.objects, 2);
  assert.equal(stats.logicalBytes, 1200);
  assert.equal(stats.dedupRatio, Number((1200 / stats.storedBytes).toFixed(2)));
  assert.equal(stats.storedBytes < 1200, true);
});

test('重复的对象 id 和参数校验', () => {
  const store = createDedupStore(SMALL);
  store.putObject({ id: 'a', data: bytes(50) });
  expectError(() => store.putObject({ id: 'a', data: bytes(50) }), 'ERR_DUPLICATE_OBJECT');
  expectError(() => store.deleteObject({ id: 'nope' }), 'ERR_UNKNOWN_OBJECT');
  expectError(() => store.createSnapshot({ name: '', objects: [] }), 'ERR_BAD_ARGS');
  expectError(() => store.createSnapshot({ name: 's', objects: 'nope' }), 'ERR_BAD_ARGS');
  expectError(() => store.putObject(null), 'ERR_BAD_ARGS');
  expectError(() => store.deleteObject(null), 'ERR_BAD_ARGS');
});
