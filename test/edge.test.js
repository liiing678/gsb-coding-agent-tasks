import test from 'node:test';
import assert from 'node:assert/strict';

import { createHeap } from '../lib/heapfit.js';
import { checkTiling, code, details, mulberry32 } from './util.js';

test('入参校验：createHeap', () => {
  for (const options of [undefined, null, 7, 'x', [], true, {}, { size: 0 }, { size: -8 },
    { size: 1.5 }, { size: '16' }, { size: NaN }, { size: Infinity }, { size: null },
    { size: 16, strategy: 'worst' }, { size: 16, strategy: null }, { size: 16, strategy: 'FIRST' },
    { size: 16, strategy: 'best ' }]) {
    assert.equal(code(() => createHeap(options)), 'ERR_BAD_ARGUMENT');
  }
  for (const options of [{ size: 8 }, { size: 1 }, { size: 16, strategy: 'first' },
    { size: 16, strategy: 'best' }, { size: 16, strategy: undefined }]) {
    assert.equal(code(() => createHeap(options)), null);
  }
  // 一个字节的堆建得起来，只是什么都分不出来
  const one = createHeap({ size: 1 });
  assert.deepEqual(one.dump(), [{ offset: 0, size: 1, used: false, capacity: 0 }]);
  assert.equal(code(() => one.alloc(0)), 'ERR_OUT_OF_MEMORY');
  // 最小的能分出来的块是「8 字节头 + 8 字节对齐」
  const eight = createHeap({ size: 8 });
  assert.equal(eight.alloc(0), 8);
  assert.deepEqual(eight.stats(), { size: 8, used: 8, free: 0, blocks: 1, freeBlocks: 0, largestFree: 0 });
  assert.equal(code(() => eight.alloc(0)), 'ERR_OUT_OF_MEMORY');
});

test('入参校验：alloc / read / write 与 details', () => {
  const heap = createHeap({ size: 256 });
  for (const bytes of [undefined, -1, 1.5, '8', NaN, Infinity, null, {}, []]) {
    assert.equal(code(() => heap.alloc(bytes)), 'ERR_BAD_ARGUMENT');
  }
  const pointer = heap.alloc(16);
  for (const length of [-1, 1.5, '2', NaN, Infinity, null, {}, []]) {
    assert.equal(code(() => heap.read(pointer, length)), 'ERR_BAD_ARGUMENT');
  }
  for (const data of [undefined, null, 'ab', [1, 2], new ArrayBuffer(2), 7, {}]) {
    assert.equal(code(() => heap.write(pointer, data)), 'ERR_BAD_ARGUMENT');
  }
  // 0 字节读写都是合法的
  assert.equal(code(() => heap.write(pointer, new Uint8Array(0))), null);
  assert.equal(code(() => heap.read(pointer, 0)), null);
  // 越界的时候 requested / capacity 都给出来
  assert.deepEqual(details(() => heap.write(pointer, new Uint8Array(17))), { requested: 17, capacity: 16 });
  assert.deepEqual(details(() => heap.read(pointer, 17)), { requested: 17, capacity: 16 });
  assert.deepEqual(details(() => heap.read(pointer, 100)), { requested: 100, capacity: 16 });
  // 装不下的时候 details 里是这一笔要占掉的块大小（头也算）
  const tight = createHeap({ size: 16 });
  assert.deepEqual(details(() => tight.alloc(16)), { slot: 24 });
  assert.deepEqual(details(() => createHeap({ size: 8 }).alloc(1)), { slot: 16 });
  // 16 的堆塞得下 alloc(0)（就一个头），再要一个就不行了
  const head = createHeap({ size: 16 });
  assert.equal(head.alloc(0), 8);
  assert.deepEqual(details(() => head.alloc(0)), { slot: 8 });
  // 申请 16 字节要占 24，所以 24 的堆装得下、16 的装不下
  assert.equal(code(() => createHeap({ size: 24 }).alloc(16)), null);
});

test('dump / stats 给的是快照，改不动内部', () => {
  const heap = createHeap({ size: 128 });
  const pointer = heap.alloc(8);
  assert.deepEqual(heap.dump(), [
    { offset: 0, size: 16, used: true, capacity: 8 },
    { offset: 16, size: 112, used: false, capacity: 0 },
  ]);
  const blocks = heap.dump();
  blocks[0].size = 9999;
  blocks[0].capacity = 9999;
  blocks[1].used = true;
  blocks.length = 0;
  const stats = heap.stats();
  stats.size = 1;
  stats.used = 1;
  assert.deepEqual(heap.dump(), [
    { offset: 0, size: 16, used: true, capacity: 8 },
    { offset: 16, size: 112, used: false, capacity: 0 },
  ]);
  assert.deepEqual(heap.stats(), { size: 128, used: 16, free: 112, blocks: 2, freeBlocks: 1, largestFree: 112 });
  assert.equal(heap.capacity(pointer), 8);
  checkTiling(heap.dump(), 128, assert);
});

test('大堆上几千次操作，账一直是对的', () => {
  const size = 1 << 16;
  const heap = createHeap({ size, strategy: 'best' });
  const random = mulberry32(20260924);
  const live = new Map();
  const started = Date.now();
  for (let step = 0; step < 5000; step += 1) {
    const roll = random();
    if (roll < 0.5 || live.size === 0) {
      const want = Math.floor(random() * 512);
      let pointer = null;
      try {
        pointer = heap.alloc(want);
      } catch (err) {
        assert.equal(err.code, 'ERR_OUT_OF_MEMORY', `第 ${step} 步分块不该失败`);
      }
      if (pointer !== null) {
        assert.equal(heap.capacity(pointer), want);
        live.set(pointer, want);
      }
    } else if (roll < 0.95) {
      const pointers = [...live.keys()];
      const pointer = pointers[Math.floor(random() * pointers.length)];
      live.delete(pointer);
      heap.free(pointer);
    } else {
      const pointers = [...live.keys()];
      const pointer = pointers[Math.floor(random() * pointers.length)];
      const capacity = live.get(pointer);
      const data = new Uint8Array(capacity);
      for (let index = 0; index < capacity; index += 1) data[index] = (index + step) % 256;
      heap.write(pointer, data);
      assert.deepEqual([...heap.read(pointer)], [...data]);
      assert.deepEqual([...heap.read(pointer, Math.floor(capacity / 2))], [...data.slice(0, Math.floor(capacity / 2))]);
    }
    checkTiling(heap.dump(), size, assert);
  }
  assert.ok(Date.now() - started < 20000, '几千次操作不该跑这么久');
  // 全放掉以后又是一整块
  for (const pointer of live.keys()) heap.free(pointer);
  assert.deepEqual(heap.dump(), [{ offset: 0, size, used: false, capacity: 0 }]);
  assert.deepEqual(heap.stats(), { size, used: 0, free: size, blocks: 1, freeBlocks: 1, largestFree: size });
});

test('碎块不会被切出来：空闲块最小 8 字节，切剩下的至少 16', () => {
  const heap = createHeap({ size: 1024 });
  const random = mulberry32(4242);
  const live = [];
  for (let step = 0; step < 300; step += 1) {
    if (live.length === 0 || random() < 0.6) {
      const want = Math.floor(random() * 200);
      try {
        live.push(heap.alloc(want));
      } catch (err) {
        assert.equal(err.code, 'ERR_OUT_OF_MEMORY');
      }
    } else {
      heap.free(live.splice(Math.floor(random() * live.length), 1)[0]);
    }
    for (const block of heap.dump()) {
      assert.ok(block.size % 8 === 0 || block.used, '空闲块大小得是 8 的倍数');
      if (!block.used) assert.ok(block.size >= 8, '空闲块最小 8 字节');
    }
  }
});
