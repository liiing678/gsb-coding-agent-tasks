import test from 'node:test';
import assert from 'node:assert/strict';
import { UploadRelay } from '../lib/relay.js';
import { sha256Hex, EMPTY_SHA256 } from '../lib/hash.js';

const bytes = (size, seed = 7) =>
  Buffer.from(Array.from({ length: size }, (_, i) => (seed + i * 37) & 0xff));

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'RelayError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

test('create：分片数按 chunkSize 向上取整，末片允许不满', () => {
  const relay = new UploadRelay();
  const body = bytes(10);
  const s = relay.create({ name: 'a.bin', size: 10, chunkSize: 4, fingerprint: sha256Hex(body) });
  assert.equal(s.id, 'u-1');
  assert.equal(s.chunkCount, 3);
  assert.deepEqual(s.received, []);
  assert.deepEqual(s.missing, [0, 1, 2]);
  assert.equal(s.receivedBytes, 0);
  assert.equal(s.state, 'open');
});

test('分片可以乱序到达，status 里收没收到一目了然', () => {
  const relay = new UploadRelay();
  const body = bytes(10);
  const s = relay.create({ name: 'a.bin', size: 10, chunkSize: 4, fingerprint: sha256Hex(body) });
  relay.putChunk(s.id, 2, body.subarray(8), sha256Hex(body.subarray(8)));
  relay.putChunk(s.id, 0, body.subarray(0, 4), sha256Hex(body.subarray(0, 4)));
  const status = relay.status(s.id);
  assert.deepEqual(status.received, [0, 2]);
  assert.deepEqual(status.missing, [1]);
  assert.equal(status.receivedBytes, 6);
});

test('同一片重传同一份内容是幂等的，不动已收状态', () => {
  const relay = new UploadRelay();
  const body = bytes(10);
  const s = relay.create({ name: 'a.bin', size: 10, chunkSize: 4, fingerprint: sha256Hex(body) });
  const first = relay.putChunk(s.id, 0, body.subarray(0, 4), sha256Hex(body.subarray(0, 4)));
  assert.equal(first.deduped, false);
  const again = relay.putChunk(s.id, 0, body.subarray(0, 4), sha256Hex(body.subarray(0, 4)));
  assert.equal(again.deduped, true);
  assert.deepEqual(relay.status(s.id).received, [0]);
  assert.equal(relay.status(s.id).receivedBytes, 4);
});

test('同一片换一份内容来传是冲突，不覆盖已收的', () => {
  const relay = new UploadRelay();
  const body = bytes(10);
  const s = relay.create({ name: 'a.bin', size: 10, chunkSize: 4, fingerprint: sha256Hex(body) });
  relay.putChunk(s.id, 1, body.subarray(4, 8), sha256Hex(body.subarray(4, 8)));
  const other = bytes(4, 99);
  const err = expectError(
    () => relay.putChunk(s.id, 1, other, sha256Hex(other)),
    'ERR_CHUNK_CONFLICT',
  );
  assert.equal(err.details.stored, sha256Hex(body.subarray(4, 8)));
  assert.deepEqual(relay.status(s.id).received, [1]);
});

test('长度不对在写库之前就被拒掉', () => {
  const relay = new UploadRelay();
  const body = bytes(10);
  const s = relay.create({ name: 'a.bin', size: 10, chunkSize: 4, fingerprint: sha256Hex(body) });
  const short = bytes(3);
  const err = expectError(
    () => relay.putChunk(s.id, 0, short, sha256Hex(short)),
    'ERR_CHUNK_SIZE',
  );
  assert.equal(err.details.expected, 4);
  assert.equal(err.details.actual, 3);
  const long = bytes(5);
  const err2 = expectError(
    () => relay.putChunk(s.id, 2, long, sha256Hex(long)),
    'ERR_CHUNK_SIZE',
  );
  assert.equal(err2.details.expected, 2);
  assert.equal(relay.status(s.id).receivedBytes, 0);
  assert.equal(relay.stats().storedBytes, 0);
});

test('内容 hash 对不上，一个字节都不落库', () => {
  const relay = new UploadRelay();
  const body = bytes(10);
  const s = relay.create({ name: 'a.bin', size: 10, chunkSize: 4, fingerprint: sha256Hex(body) });
  const chunk = body.subarray(0, 4);
  const err = expectError(
    () => relay.putChunk(s.id, 0, chunk, sha256Hex(bytes(4, 1))),
    'ERR_CHUNK_HASH_MISMATCH',
  );
  assert.equal(err.details.declared, sha256Hex(bytes(4, 1)));
  assert.equal(err.details.actual, sha256Hex(chunk));
  assert.equal(relay.stats().blobs, 0);
  assert.deepEqual(relay.status(s.id).received, []);
});

test('hash 得是 64 位小写 hex', () => {
  const relay = new UploadRelay();
  const body = bytes(10);
  const s = relay.create({ name: 'a.bin', size: 10, chunkSize: 4, fingerprint: sha256Hex(body) });
  expectError(
    () => relay.putChunk(s.id, 0, body.subarray(0, 4), sha256Hex(body.subarray(0, 4)).toUpperCase()),
    'ERR_BAD_HASH',
  );
});

test('分片下标越界', () => {
  const relay = new UploadRelay();
  const body = bytes(10);
  const s = relay.create({ name: 'a.bin', size: 10, chunkSize: 4, fingerprint: sha256Hex(body) });
  expectError(() => relay.putChunk(s.id, 3, bytes(4), sha256Hex(bytes(4))), 'ERR_CHUNK_OUT_OF_RANGE');
  expectError(() => relay.putChunk(s.id, -1, bytes(4), sha256Hex(bytes(4))), 'ERR_CHUNK_OUT_OF_RANGE');
  expectError(() => relay.putChunk(s.id, 1.5, bytes(4), sha256Hex(bytes(4))), 'ERR_CHUNK_OUT_OF_RANGE');
});

test('不认识的会话号', () => {
  const relay = new UploadRelay();
  expectError(() => relay.status('u-404'), 'ERR_UNKNOWN_UPLOAD');
  expectError(() => relay.putChunk('u-404', 0, bytes(4), sha256Hex(bytes(4))), 'ERR_UNKNOWN_UPLOAD');
  expectError(() => relay.complete('u-404'), 'ERR_UNKNOWN_UPLOAD');
});

test('还差分片就不给收尾，缺哪几片要列出来', () => {
  const relay = new UploadRelay();
  const body = bytes(10);
  const s = relay.create({ name: 'a.bin', size: 10, chunkSize: 4, fingerprint: sha256Hex(body) });
  relay.putChunk(s.id, 0, body.subarray(0, 4), sha256Hex(body.subarray(0, 4)));
  relay.putChunk(s.id, 1, body.subarray(4, 8), sha256Hex(body.subarray(4, 8)));
  const err = expectError(() => relay.complete(s.id), 'ERR_INCOMPLETE');
  assert.deepEqual(err.details.missing, [2]);
});

test('收齐了就拼得回原文件，收尾过的会话不能再动', () => {
  const relay = new UploadRelay();
  const body = bytes(10);
  const s = relay.create({ name: 'a.bin', size: 10, chunkSize: 4, fingerprint: sha256Hex(body) });
  relay.putChunk(s.id, 1, body.subarray(4, 8), sha256Hex(body.subarray(4, 8)));
  relay.putChunk(s.id, 0, body.subarray(0, 4), sha256Hex(body.subarray(0, 4)));
  relay.putChunk(s.id, 2, body.subarray(8), sha256Hex(body.subarray(8)));
  const out = relay.complete(s.id);
  assert.equal(Buffer.compare(out, body), 0);
  assert.equal(relay.status(s.id).state, 'complete');
  expectError(() => relay.complete(s.id), 'ERR_NOT_OPEN');
  expectError(() => relay.putChunk(s.id, 0, body.subarray(0, 4), sha256Hex(body.subarray(0, 4))), 'ERR_NOT_OPEN');
  expectError(() => relay.abort(s.id), 'ERR_NOT_OPEN');
});

test('空文件也能走完流程', () => {
  const relay = new UploadRelay();
  const s = relay.create({ name: 'empty.txt', size: 0, chunkSize: 4, fingerprint: EMPTY_SHA256 });
  assert.equal(s.chunkCount, 0);
  assert.deepEqual(s.missing, []);
  const out = relay.complete(s.id);
  assert.equal(out.length, 0);
});

test('整份文件的 hash 对不上，会话保持原样等着重传', () => {
  const relay = new UploadRelay();
  const body = bytes(8);
  const s = relay.create({
    name: 'a.bin',
    size: 8,
    chunkSize: 4,
    fingerprint: sha256Hex(bytes(8, 3)),
  });
  relay.putChunk(s.id, 0, body.subarray(0, 4), sha256Hex(body.subarray(0, 4)));
  relay.putChunk(s.id, 1, body.subarray(4), sha256Hex(body.subarray(4)));
  const err = expectError(() => relay.complete(s.id), 'ERR_FINGERPRINT_MISMATCH');
  assert.equal(err.details.actual, sha256Hex(body));
  const status = relay.status(s.id);
  assert.equal(status.state, 'open');
  assert.deepEqual(status.received, [0, 1]);
});

test('放弃的会话就彻底不能用了', () => {
  const relay = new UploadRelay();
  const body = bytes(10);
  const s = relay.create({ name: 'a.bin', size: 10, chunkSize: 4, fingerprint: sha256Hex(body) });
  relay.putChunk(s.id, 0, body.subarray(0, 4), sha256Hex(body.subarray(0, 4)));
  const out = relay.abort(s.id);
  assert.deepEqual(out.freed, [sha256Hex(body.subarray(0, 4))]);
  assert.equal(relay.status(s.id).state, 'aborted');
  expectError(() => relay.putChunk(s.id, 1, bytes(4), sha256Hex(bytes(4))), 'ERR_NOT_OPEN');
});

test('create 的参数逐个校验', () => {
  const relay = new UploadRelay();
  const fingerprint = sha256Hex(bytes(4));
  expectError(() => relay.create({ name: '', size: 4, chunkSize: 4, fingerprint }), 'ERR_BAD_REQUEST');
  expectError(() => relay.create({ name: 'a', size: -1, chunkSize: 4, fingerprint }), 'ERR_BAD_REQUEST');
  expectError(() => relay.create({ name: 'a', size: 4, chunkSize: 0, fingerprint }), 'ERR_BAD_REQUEST');
  expectError(
    () => relay.create({ name: 'a', size: 4, chunkSize: 1048577, fingerprint }),
    'ERR_BAD_REQUEST',
  );
  expectError(() => relay.create({ name: 'a', size: 4, chunkSize: 4, fingerprint: 'abc' }), 'ERR_BAD_REQUEST');
});

test('指定 id 时不能和已有的撞', () => {
  const relay = new UploadRelay();
  const fingerprint = sha256Hex(bytes(4));
  relay.create({ id: 'job-1', name: 'a', size: 4, chunkSize: 4, fingerprint });
  expectError(() => relay.create({ id: 'job-1', name: 'b', size: 4, chunkSize: 4, fingerprint }), 'ERR_BAD_REQUEST');
  assert.equal(relay.create({ name: 'c', size: 4, chunkSize: 4, fingerprint }).id, 'u-1');
});
