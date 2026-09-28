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

/** 固定种子的 xorshift32，保证每次跑出来一样。 */
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

test('chunk 按滑窗滚动哈希切：块长有下限、有上限、切点由内容决定', () => {
  const store = createDedupStore(SMALL);
  const pieces = store.chunk(bytes(200));
  assert.deepEqual(pieces.map((one) => one.offset), [0, 8, 27, 50, 59, 69, 81, 91, 108, 116, 124, 135, 148, 179, 187, 195]);
  assert.deepEqual(pieces.map((one) => one.size), [8, 19, 23, 9, 10, 12, 10, 17, 8, 8, 11, 13, 31, 8, 8, 5]);
  assert.equal(pieces.every((one) => one.size >= SMALL.minBytes || one.offset + one.size === 200), true);
  assert.equal(pieces.every((one) => one.size <= SMALL.maxBytes), true);
  assert.equal(pieces[0].hash, '8c58cf8e029fb44a0cad5835f09e55749f722fc95d1f9388cad5ca0e88d9f37d');
  assert.match(pieces[0].hash, /^[0-9a-f]{64}$/);
});

test('空数据没有块，小于下限的数据就一块', () => {
  const store = createDedupStore(SMALL);
  assert.deepEqual(store.chunk(Buffer.alloc(0)), []);
  assert.deepEqual(store.chunk(bytes(5)).map((one) => [one.offset, one.size]), [[0, 5]]);
});

test('put 同样的内容第二次一个新块都不用建', () => {
  const store = createDedupStore(SMALL);
  const data = bytes(300);
  const first = store.putObject({ id: 'a', data });
  const second = store.putObject({ id: 'b', data: Buffer.from(data) });
  assert.equal(first.newChunks, first.chunks);
  assert.equal(second.newChunks, 0);
  assert.equal(second.reusedChunks, second.chunks);
  assert.equal(store.stats().chunks, first.chunks);
});

test('前面插几个字节，只有开头那块变，后面都还能复用', () => {
  const store = createDedupStore(SMALL);
  const data = bytes(600);
  const before = store.putObject({ id: 'a', data });
  const shifted = Buffer.concat([bytes(3, 99), data]);
  const after = store.putObject({ id: 'b', data: shifted });
  assert.equal(before.chunks > 10, true);
  assert.equal(after.newChunks <= 2, true);
});

test('同一段内容出现两次时第二次不算新块', () => {
  const store = createDedupStore(SMALL);
  const block = bytes(400, 7);
  const once = store.putObject({ id: 'a', data: block });
  const twice = store.putObject({ id: 'b', data: Buffer.concat([block, block]) });
  assert.equal(once.newChunks, once.chunks);
  assert.equal(twice.newChunks <= once.chunks, true);
  assert.equal(store.stats().dedupRatio > 1, true);
});

test('拿回来的是拷贝，改输入或改返回值都动不了库里那份', () => {
  const store = createDedupStore(SMALL);
  const original = bytes(100, 5);
  const data = Buffer.from(original);
  store.putObject({ id: 'a', data });
  data[0] = 255;                       // 存完再改输入
  const out = store.getObject({ id: 'a' });
  assert.deepEqual(out, original);
  assert.notEqual(out, store.getObject({ id: 'a' }));
  out[1] = 255;                        // 改拿出来的这份
  assert.deepEqual(store.getObject({ id: 'a' }), original);
});

test('参数不合法时各报哪个码', () => {
  const store = createDedupStore(SMALL);
  expectError(() => store.chunk('nope'), 'ERR_BAD_ARGS');
  expectError(() => store.putObject({ id: '', data: bytes(10) }), 'ERR_BAD_ARGS');
  expectError(() => store.putObject({ id: 'a', data: 'nope' }), 'ERR_BAD_ARGS');
  expectError(() => store.getObject({ id: 'nope' }), 'ERR_UNKNOWN_OBJECT');
  expectError(() => createDedupStore(null), 'ERR_BAD_CONFIG');
  expectError(() => createDedupStore({ minBytes: 0 }), 'ERR_BAD_CONFIG');
  expectError(() => createDedupStore({ minBytes: 64, maxBytes: 32 }), 'ERR_BAD_CONFIG');
  expectError(() => createDedupStore({ boundaryBits: 0 }), 'ERR_BAD_CONFIG');
  expectError(() => createDedupStore({ windowBytes: 0 }), 'ERR_BAD_CONFIG');
});
