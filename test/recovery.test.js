import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { createMemoryLog } from '../lib/log.js';
import { decodeFrames } from '../lib/codec.js';

function writeTwoCommits() {
  const log = createMemoryLog();
  const store = createStore({ log });
  const first = store.begin();
  store.set(first, 'a', '1');
  store.set(first, 'b', '1');
  store.commit(first);
  const second = store.begin();
  store.set(second, 'a', '2');
  store.commit(second);
  return { log, bytes: log.bytes() };
}

test('拿日志字节重新开一个 store，状态一模一样', () => {
  const { bytes } = writeTwoCommits();
  const log = createMemoryLog(bytes);
  const store = createStore({ log });
  const stats = store.stats();
  assert.equal(stats.version, 2);
  assert.deepEqual(store.get('a'), { key: 'a', value: '2', version: 2 });
  assert.deepEqual(store.get('b'), { key: 'b', value: '1', version: 1 });
  assert.deepEqual(store.history('a'), [
    { version: 1, value: '1' },
    { version: 2, value: '2' },
  ]);
  assert.equal(stats.recovery.reason, 'clean');
  assert.equal(stats.recovery.frames, 5);
});

test('没提交的事务写下去的帧，恢复时要丢掉', () => {
  const log = createMemoryLog();
  const store = createStore({ log });
  const first = store.begin();
  store.set(first, 'keep', 'yes');
  store.commit(first);
  const half = store.begin();
  store.set(half, 'drop', 'no');
  store.set(half, 'keep', 'overwritten');

  const revived = createStore({ log: createMemoryLog(log.bytes()) });
  assert.equal(revived.get('drop'), null);
  assert.deepEqual(revived.get('keep'), { key: 'keep', value: 'yes', version: 1 });
  assert.equal(revived.stats().version, 1);
  assert.equal(revived.stats().pendingTxns, 0);
});

test('尾部被切掉几字节：坏的那帧不要，之前提交的都还在', () => {
  const { bytes, log } = writeTwoCommits();
  const tailFrame = decodeFrames(bytes).frames.at(-1);
  for (let cut = 1; cut <= 12; cut++) {
    const truncated = bytes.subarray(0, bytes.length - cut);
    const revived = createStore({ log: createMemoryLog(truncated) });
    const stats = revived.stats();
    assert.equal(stats.recovery.droppedBytes, truncated.length - tailFrame.start, `cut=${cut}`);
    assert.equal(stats.recovery.reason, 'torn', `cut=${cut}`);
    assert.equal(stats.version, 1, `cut=${cut}`);
    assert.deepEqual(revived.get('a'), { key: 'a', value: '1', version: 1 }, `cut=${cut}`);
    assert.equal(stats.walBytes, tailFrame.start, `cut=${cut}`);
  }
  assert.equal(log.bytes().length, bytes.length);
});

test('恢复之后接着写，版本号接着涨，再恢复一次还对', () => {
  const { bytes } = writeTwoCommits();
  const log = createMemoryLog(bytes);
  const store = createStore({ log });
  const txn = store.begin();
  store.set(txn, 'c', '3');
  const out = store.commit(txn);
  assert.equal(out.version, 3);

  const again = createStore({ log: createMemoryLog(log.bytes()) });
  assert.equal(again.stats().version, 3);
  assert.equal(again.get('c').value, '3');
});

test('中间有帧校验不过：从那一帧开始全不要，日志截回去', () => {
  const { bytes } = writeTwoCommits();
  const frames = decodeFrames(bytes).frames;
  const target = frames[3];
  const corrupted = Buffer.from(bytes);
  corrupted[target.start + 9] = corrupted[target.start + 9] ^ 0xff;

  const log = createMemoryLog(corrupted);
  const store = createStore({ log });
  const stats = store.stats();
  assert.equal(stats.recovery.reason, 'bad-crc');
  assert.equal(stats.walBytes, target.start);
  assert.equal(stats.version, frames[2].body.version);
  assert.equal(stats.keys, 2);
  assert.equal(store.get('a').value, '1');

  const txn = store.begin();
  store.set(txn, 'a', 'after');
  store.commit(txn);
  const again = createStore({ log: createMemoryLog(log.bytes()) });
  assert.equal(again.get('a').value, 'after');
});

test('整段日志被切到只剩半帧也是干净的初始状态', () => {
  const { bytes } = writeTwoCommits();
  const store = createStore({ log: createMemoryLog(bytes.subarray(0, 5)) });
  assert.equal(store.stats().version, 0);
  assert.equal(store.stats().keys, 0);
  assert.equal(store.stats().walBytes, 0);
  assert.equal(store.stats().recovery.reason, 'torn');
});
