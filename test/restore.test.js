import test from 'node:test';
import assert from 'node:assert/strict';
import { UploadRelay } from '../lib/relay.js';
import { sha256Hex } from '../lib/hash.js';

const bytes = (size, seed = 7) =>
  Buffer.from(Array.from({ length: size }, (_, i) => (seed + i * 37) & 0xff));

test('进程重启后接着传：快照搬过去还能收尾', () => {
  const body = bytes(10);
  const fingerprint = sha256Hex(body);
  const before = new UploadRelay();
  const s = before.create({ name: 'a.bin', size: 10, chunkSize: 4, fingerprint });
  before.putChunk(s.id, 2, body.subarray(8), sha256Hex(body.subarray(8)));
  before.putChunk(s.id, 0, body.subarray(0, 4), sha256Hex(body.subarray(0, 4)));
  const snap = before.snapshot();

  const after = new UploadRelay().restore(JSON.parse(JSON.stringify(snap)));
  assert.deepEqual(after.status(s.id).received, [0, 2]);
  assert.deepEqual(after.status(s.id).missing, [1]);
  assert.equal(after.stats().storedBytes, 6);
  after.putChunk(s.id, 1, body.subarray(4, 8), sha256Hex(body.subarray(4, 8)));
  assert.equal(Buffer.compare(after.complete(s.id), body), 0);
});

test('恢复之后事件序号接着涨，自动编号不会重号', () => {
  const body = bytes(4);
  const fingerprint = sha256Hex(body);
  const before = new UploadRelay();
  before.create({ name: 'a.bin', size: 4, chunkSize: 4, fingerprint });
  before.create({ name: 'b.bin', size: 4, chunkSize: 4, fingerprint });
  const after = new UploadRelay().restore(before.snapshot());
  const seen = [];
  after.onEvent((ev) => seen.push(ev));
  assert.equal(after.create({ name: 'c.bin', size: 4, chunkSize: 4, fingerprint }).id, 'u-3');
  assert.equal(seen[0].seq, 3);
});

test('快照版本不对就直说', () => {
  const relay = new UploadRelay();
  let code = '';
  try {
    relay.restore({ version: 99 });
  } catch (err) {
    code = err.code;
  }
  assert.equal(code, 'ERR_BAD_SNAPSHOT');
});
