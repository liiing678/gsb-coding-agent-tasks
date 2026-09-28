import test from 'node:test';
import assert from 'node:assert/strict';

import { createHeap } from '../lib/heapfit.js';
import { checkTiling, code, createOracle, details, mulberry32 } from './util.js';

test('初始状态、指针形状与容量', () => {
  const heap = createHeap({ size: 256 });
  assert.deepEqual(heap.stats(), { size: 256, used: 0, free: 256, blocks: 1, freeBlocks: 1, largestFree: 256 });
  assert.deepEqual(heap.dump(), [{ offset: 0, size: 256, used: false, capacity: 0 }]);

  const zero = heap.alloc(0);
  assert.equal(zero, 8);
  assert.equal(heap.capacity(zero), 0);
  const small = heap.alloc(8);
  const bigger = heap.alloc(24);
  assert.equal(small, 16);
  assert.equal(bigger, 32);
  for (const pointer of [zero, small, bigger]) {
    assert.equal(pointer % 8, 0, '指针得 8 字节对齐');
    assert.ok(pointer >= 8);
  }
  assert.deepEqual(heap.dump(), [
    { offset: 0, size: 8, used: true, capacity: 0 },
    { offset: 8, size: 16, used: true, capacity: 8 },
    { offset: 24, size: 32, used: true, capacity: 24 },
    { offset: 56, size: 200, used: false, capacity: 0 },
  ]);
  assert.deepEqual(heap.stats(), { size: 256, used: 56, free: 200, blocks: 4, freeBlocks: 1, largestFree: 200 });
  assert.equal(heap.capacity(bigger), 24);
  // 申请 24 字节要占 24 + 8 再往上凑到 8 的倍数
  assert.equal(heap.dump()[2].size, 32);
});

test('首次适配与最佳适配，切不动就别切', () => {
  const build = (strategy) => {
    const heap = createHeap({ size: 512, strategy });
    const big = heap.alloc(400);
    const mid = heap.alloc(40);
    const small = heap.alloc(8);
    heap.free(big);
    heap.free(small);
    return { heap, mid, big, small };
  };
  // 内存里先是 408 的空闲块，后面还有 56 的：first 拿前面那块，best 拿小那块
  const first = build('first');
  assert.equal(first.heap.alloc(8), 8);
  assert.deepEqual(first.heap.dump(), [
    { offset: 0, size: 16, used: true, capacity: 8 },
    { offset: 16, size: 392, used: false, capacity: 0 },
    { offset: 408, size: 48, used: true, capacity: 40 },
    { offset: 456, size: 56, used: false, capacity: 0 },
  ]);
  const best = build('best');
  assert.equal(best.heap.alloc(8), 464);
  assert.deepEqual(best.heap.dump(), [
    { offset: 0, size: 408, used: false, capacity: 0 },
    { offset: 408, size: 48, used: true, capacity: 40 },
    { offset: 456, size: 16, used: true, capacity: 8 },
    { offset: 472, size: 40, used: false, capacity: 0 },
  ]);
  // 不写 strategy 就是 best
  const fallback = build(undefined);
  assert.equal(fallback.heap.alloc(8), 464);
  assert.equal(fallback.heap.capacity(fallback.mid), 40);

  // 切完剩下的正好 16 就切
  const gap = createHeap({ size: 40 });
  assert.equal(gap.alloc(16), 8);
  assert.deepEqual(gap.dump(), [
    { offset: 0, size: 24, used: true, capacity: 16 },
    { offset: 24, size: 16, used: false, capacity: 0 },
  ]);
  assert.equal(gap.stats().largestFree, 16);
  // 剩下不到 16 就整块给它，多出来的算浪费
  const tight = createHeap({ size: 32 });
  assert.equal(tight.alloc(16), 8);
  assert.deepEqual(tight.dump(), [{ offset: 0, size: 32, used: true, capacity: 16 }]);
  assert.deepEqual(tight.stats(), { size: 32, used: 32, free: 0, blocks: 1, freeBlocks: 0, largestFree: 0 });
  assert.equal(code(() => tight.alloc(1)), 'ERR_OUT_OF_MEMORY');
  // 24 里塞 8：头 8 + 8 字节，剩 8 不够 16，整块给走
  const tiny = createHeap({ size: 24 });
  assert.equal(tiny.alloc(8), 8);
  assert.deepEqual(tiny.dump(), [{ offset: 0, size: 24, used: true, capacity: 8 }]);
});

test('释放、合并与 stats', () => {
  const heap = createHeap({ size: 96 });
  const first = heap.alloc(0);
  const second = heap.alloc(0);
  const third = heap.alloc(0);
  assert.deepEqual([first, second, third], [8, 16, 24]);
  assert.deepEqual(heap.dump(), [
    { offset: 0, size: 8, used: true, capacity: 0 },
    { offset: 8, size: 8, used: true, capacity: 0 },
    { offset: 16, size: 8, used: true, capacity: 0 },
    { offset: 24, size: 72, used: false, capacity: 0 },
  ]);
  // 中间那块两边都占着，还回去就是孤零零一个空闲块
  assert.equal(heap.free(second), 8);
  assert.equal(heap.stats().freeBlocks, 2);
  assert.deepEqual(heap.dump()[1], { offset: 8, size: 8, used: false, capacity: 0 });
  // 右边那块一还，跟后面的空闲块、再跟左边那块一路合起来
  assert.equal(heap.free(third), 8);
  assert.deepEqual(heap.dump(), [
    { offset: 0, size: 8, used: true, capacity: 0 },
    { offset: 8, size: 88, used: false, capacity: 0 },
  ]);
  assert.equal(heap.free(first), 8);
  assert.deepEqual(heap.dump(), [{ offset: 0, size: 96, used: false, capacity: 0 }]);
  assert.deepEqual(heap.stats(), { size: 96, used: 0, free: 96, blocks: 1, freeBlocks: 1, largestFree: 96 });
  checkTiling(heap.dump(), 96, assert);

  // 还回去的地要能马上再分出去
  const reuse = createHeap({ size: 256 });
  const small = reuse.alloc(8);
  const hole = reuse.alloc(0);
  reuse.free(hole);
  assert.equal(reuse.alloc(0), hole);
  assert.equal(reuse.capacity(small), 8);
  assert.equal(reuse.stats().freeBlocks, 1);
});

test('读写与越界', () => {
  const heap = createHeap({ size: 256 });
  const first = heap.alloc(8);
  const second = heap.alloc(24);
  assert.deepEqual([...heap.read(first)], [0, 0, 0, 0, 0, 0, 0, 0]);
  heap.write(first, new Uint8Array([1, 2, 3]));
  assert.deepEqual([...heap.read(first)], [1, 2, 3, 0, 0, 0, 0, 0]);
  assert.deepEqual([...heap.read(first, 2)], [1, 2]);
  // 短写只盖前面那几个字节
  heap.write(first, new Uint8Array([9]));
  assert.deepEqual([...heap.read(first)], [9, 2, 3, 0, 0, 0, 0, 0]);
  // 读出来的是拷贝，改它不影响堆里那份
  const copy = heap.read(first);
  copy[0] = 77;
  assert.deepEqual([...heap.read(first)], [9, 2, 3, 0, 0, 0, 0, 0]);
  // 不写长度就读满这块
  assert.equal(heap.read(second).length, 24);
  assert.deepEqual([...heap.read(second)], new Array(24).fill(0));
  // 越界：写进去的比申请的多、读的比申请的多
  assert.equal(code(() => heap.write(second, new Uint8Array(25))), 'ERR_OUT_OF_BOUNDS');
  assert.deepEqual(details(() => heap.write(second, new Uint8Array(25))), { requested: 25, capacity: 24 });
  assert.equal(code(() => heap.read(second, 25)), 'ERR_OUT_OF_BOUNDS');
  assert.deepEqual(details(() => heap.read(second, 25)), { requested: 25, capacity: 24 });
  // 正好写满 / 读满是允许的
  assert.equal(code(() => heap.write(second, new Uint8Array(24))), null);
  assert.equal(code(() => heap.read(second, 24)), null);
  // 0 字节的块什么也写不进去
  const zero = heap.alloc(0);
  assert.equal(code(() => heap.read(zero)), null);
  assert.equal(code(() => heap.write(zero, new Uint8Array(1))), 'ERR_OUT_OF_BOUNDS');
  assert.equal(code(() => heap.write(zero, new Uint8Array(0))), null);
  // 相邻的块各写各的，互不串味
  const neighbour = heap.alloc(8);
  heap.write(first, new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]));
  heap.write(neighbour, new Uint8Array([2, 2, 2, 2, 2, 2, 2, 2]));
  assert.deepEqual([...heap.read(first)], new Array(8).fill(1));
  assert.deepEqual([...heap.read(neighbour)], new Array(8).fill(2));
});

test('坏指针一律 ERR_BAD_POINTER', () => {
  const heap = createHeap({ size: 256 });
  const live = heap.alloc(16);
  assert.equal(code(() => heap.free(live)), null);
  assert.equal(code(() => heap.free(live)), 'ERR_BAD_POINTER');
  for (const pointer of [0, 4, -8, 8, 999, 1.5, NaN, '8', null, undefined, {}]) {
    assert.equal(code(() => heap.free(pointer)), 'ERR_BAD_POINTER');
    assert.equal(code(() => heap.capacity(pointer)), 'ERR_BAD_POINTER');
    assert.equal(code(() => heap.read(pointer, 1)), 'ERR_BAD_POINTER');
    assert.equal(code(() => heap.write(pointer, new Uint8Array(1))), 'ERR_BAD_POINTER');
  }
  // 指针先查，长度非法就轮不到了
  assert.equal(code(() => heap.read(0, -1)), 'ERR_BAD_POINTER');
  // 释放过的指针不能再读写，哪怕那块地又被分出去了
  const again = heap.alloc(16);
  assert.equal(again, live);
  assert.equal(code(() => heap.capacity(live)), null);
  heap.free(again);
  assert.equal(code(() => heap.read(again, 1)), 'ERR_BAD_POINTER');
});

test('随机走一通：区域不许重叠，账要对得上', () => {
  for (let round = 0; round < 20; round += 1) {
    const size = 512 + round * 32;
    const random = mulberry32(round * 7919 + 11);
    const heap = createHeap({ size, strategy: round % 2 === 0 ? 'best' : 'first' });
    const oracle = createOracle(size);
    const live = new Map();
    for (let step = 0; step < 300; step += 1) {
      if (live.size === 0 || random() < 0.55) {
        const want = Math.floor(random() * 80);
        let pointer = null;
        try {
          pointer = heap.alloc(want);
        } catch (err) {
          assert.equal(err.code, 'ERR_OUT_OF_MEMORY', `第 ${round} 轮第 ${step} 步分了块不该失败`);
          continue;
        }
        const block = heap.dump().find((entry) => entry.used && entry.offset === pointer - 8);
        assert.ok(block, '指针得能对上块');
        assert.equal(block.capacity, want);
        assert.ok(oracle.claim(pointer, block.offset, block.size),
          `第 ${round} 轮第 ${step} 步拿到了一块已经有人占的地`);
        live.set(pointer, block.size);
      } else {
        const pointers = [...live.keys()];
        const pointer = pointers[Math.floor(random() * pointers.length)];
        const blockSize = live.get(pointer);
        live.delete(pointer);
        heap.free(pointer);
        assert.ok(oracle.release(pointer, pointer - 8, blockSize), '还回去的地不是它的');
      }
      const dump = heap.dump();
      const stats = heap.stats();
      checkTiling(dump, size, assert);
      assert.equal(stats.size, size);
      assert.equal(stats.used + stats.free, size);
      assert.equal(stats.used, dump.filter((block) => block.used).reduce((sum, block) => sum + block.size, 0));
      assert.equal(stats.blocks, dump.length);
      assert.equal(stats.freeBlocks, dump.filter((block) => !block.used).length);
      assert.equal(stats.free, oracle.freeBytes(), `第 ${round} 轮第 ${step} 步空闲字节对不上`);
      assert.equal(stats.largestFree, oracle.largestFree(), `第 ${round} 轮第 ${step} 步最大空闲块对不上`);
    }
    for (const pointer of live.keys()) heap.free(pointer);
    assert.deepEqual(heap.dump(), [{ offset: 0, size, used: false, capacity: 0 }]);
  }
});