// 跑在定长区间上的分配器：切分、首次 / 最佳适配、释放合并。
//
// 堆是一条按 offset 升序的双向链表，每块要么占用要么空闲，严丝合缝铺满 [0, size)。
// 每块前面有 8 字节头，返回的指针 = 块 offset + 8；活着的指针记在 live 表里，
// 指向对应的块节点，释放时靠它 O(1) 找到块并跟左右空闲邻居合并。

import { HeapError } from './errors.js';

const HEADER = 8;
// 切完剩下的不到 16 字节就不切了，整块给出去
const MIN_REMAINDER = 16;

const badArgument = () => new HeapError('ERR_BAD_ARGUMENT', '参数不合法');
const badPointer = () => new HeapError('ERR_BAD_POINTER', '指针不是活着的分配结果');

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

export function createHeap(options) {
  if (!isPlainObject(options)) throw badArgument();
  const { size, strategy = 'best' } = options;
  if (!Number.isInteger(size) || size <= 0) throw badArgument();
  if (strategy !== 'first' && strategy !== 'best') throw badArgument();

  const head = {
    offset: 0,
    size,
    used: false,
    capacity: 0,
    data: null,
    prev: null,
    next: null,
  };
  // 活着的指针 -> 块节点
  const live = new Map();

  const lookup = (pointer) => {
    if (!live.has(pointer)) throw badPointer();
    return live.get(pointer);
  };

  const alloc = (n) => {
    if (!isNonNegativeInteger(n)) throw badArgument();
    // 头也算在占用里，再往上凑到 8 的倍数
    const slot = Math.ceil((n + HEADER) / 8) * 8;
    let target = null;
    if (strategy === 'first') {
      for (let block = head; block; block = block.next) {
        if (!block.used && block.size >= slot) {
          target = block;
          break;
        }
      }
    } else {
      // 装得下里面最小的；并列时先遇到的 offset 小，保持严格小于即可
      for (let block = head; block; block = block.next) {
        if (!block.used && block.size >= slot && (target === null || block.size < target.size)) {
          target = block;
        }
      }
    }
    if (target === null) {
      throw new HeapError('ERR_OUT_OF_MEMORY', '没有装得下这一笔的空闲块', { slot });
    }
    if (target.size - slot >= MIN_REMAINDER) {
      const rest = {
        offset: target.offset + slot,
        size: target.size - slot,
        used: false,
        capacity: 0,
        data: null,
        prev: target,
        next: target.next,
      };
      if (target.next) target.next.prev = rest;
      target.next = rest;
      target.size = slot;
    }
    target.used = true;
    target.capacity = n;
    target.data = new Uint8Array(n);
    const pointer = target.offset + HEADER;
    live.set(pointer, target);
    return pointer;
  };

  const free = (pointer) => {
    const block = lookup(pointer);
    live.delete(pointer);
    const released = block.size;
    block.used = false;
    block.capacity = 0;
    block.data = null;
    // 先并右边，再并左边；空闲块本来互不相邻，两边各并一次就恢复不变式
    if (block.next && !block.next.used) {
      block.size += block.next.size;
      block.next = block.next.next;
      if (block.next) block.next.prev = block;
    }
    if (block.prev && !block.prev.used) {
      block.prev.size += block.size;
      block.prev.next = block.next;
      if (block.next) block.next.prev = block.prev;
    }
    return released;
  };

  const capacity = (pointer) => lookup(pointer).capacity;

  const read = (pointer, length) => {
    const block = lookup(pointer);
    const wanted = length === undefined ? block.capacity : length;
    if (!isNonNegativeInteger(wanted)) throw badArgument();
    if (wanted > block.capacity) {
      throw new HeapError('ERR_OUT_OF_BOUNDS', '读的范围超出这块的容量', {
        requested: wanted,
        capacity: block.capacity,
      });
    }
    // slice 出来的是拷贝，改它动不了堆里那份
    return block.data.slice(0, wanted);
  };

  const write = (pointer, data) => {
    const block = lookup(pointer);
    if (!(data instanceof Uint8Array)) throw badArgument();
    if (data.length > block.capacity) {
      throw new HeapError('ERR_OUT_OF_BOUNDS', '写的范围超出这块的容量', {
        requested: data.length,
        capacity: block.capacity,
      });
    }
    // 短写只盖前面几个字节，后面保持原样
    block.data.set(data);
  };

  const dump = () => {
    const blocks = [];
    for (let block = head; block; block = block.next) {
      blocks.push({
        offset: block.offset,
        size: block.size,
        used: block.used,
        capacity: block.used ? block.capacity : 0,
      });
    }
    return blocks;
  };

  const stats = () => {
    let used = 0;
    let freeBytes = 0;
    let blocks = 0;
    let freeBlocks = 0;
    let largestFree = 0;
    for (let block = head; block; block = block.next) {
      blocks += 1;
      if (block.used) {
        used += block.size;
      } else {
        freeBytes += block.size;
        freeBlocks += 1;
        if (block.size > largestFree) largestFree = block.size;
      }
    }
    return { size, used, free: freeBytes, blocks, freeBlocks, largestFree };
  };

  return { alloc, free, capacity, read, write, dump, stats };
}
