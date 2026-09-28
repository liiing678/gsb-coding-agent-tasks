import { HeapError } from './errors.js';

const HEADER_SIZE = 8;
const MIN_SPLIT_REMAINDER = 16;

const badArgument = (message) => new HeapError('ERR_BAD_ARGUMENT', message, {});

const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

export function createHeap(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw badArgument('createHeap 的参数必须是对象');
  }

  const { size } = options;
  if (!Number.isInteger(size) || size <= 0) {
    throw badArgument('size 必须是正整数');
  }

  const strategy = options.strategy === undefined ? 'best' : options.strategy;
  if (strategy !== 'first' && strategy !== 'best') {
    throw badArgument("strategy 必须是 'first' 或 'best'");
  }

  const firstBlock = {
    offset: 0,
    size,
    used: false,
    capacity: 0,
    data: null,
    previous: null,
    next: null,
  };

  let blocks = firstBlock;
  const liveByPointer = new Map();

  const getLiveBlock = (pointer) => liveByPointer.get(pointer);

  const requireLiveBlock = (pointer) => {
    const block = getLiveBlock(pointer);
    if (block === undefined) {
      throw new HeapError('ERR_BAD_POINTER', '指针不是当前活着的分配指针', {});
    }
    return block;
  };

  function alloc(n) {
    if (!isNonNegativeInteger(n)) {
      throw badArgument('alloc 的参数必须是非负整数');
    }

    const slot = Math.ceil((n + HEADER_SIZE) / HEADER_SIZE) * HEADER_SIZE;
    let chosen = null;

    for (let block = blocks; block !== null; block = block.next) {
      if (block.used || block.size < slot) continue;

      if (chosen === null) {
        chosen = block;
        if (strategy === 'first') break;
      } else if (block.size < chosen.size) {
        chosen = block;
      }
    }

    if (chosen === null) {
      throw new HeapError('ERR_OUT_OF_MEMORY', '没有足够大的空闲块', { slot });
    }

    const remainder = chosen.size - slot;
    if (remainder >= MIN_SPLIT_REMAINDER) {
      const freeBlock = {
        offset: chosen.offset + slot,
        size: remainder,
        used: false,
        capacity: 0,
        data: null,
        previous: chosen,
        next: chosen.next,
      };
      if (chosen.next !== null) chosen.next.previous = freeBlock;
      chosen.next = freeBlock;
      chosen.size = slot;
    }

    chosen.used = true;
    chosen.capacity = n;
    chosen.data = new Uint8Array(n);

    const pointer = chosen.offset + HEADER_SIZE;
    liveByPointer.set(pointer, chosen);
    return pointer;
  }

  function free(pointer) {
    const block = requireLiveBlock(pointer);
    const freedSize = block.size;

    liveByPointer.delete(pointer);
    block.used = false;
    block.capacity = 0;
    block.data = null;

    const right = block.next;
    if (right !== null && !right.used) {
      block.size += right.size;
      block.next = right.next;
      if (right.next !== null) right.next.previous = block;
    }

    const left = block.previous;
    if (left !== null && !left.used) {
      left.size += block.size;
      left.next = block.next;
      if (block.next !== null) block.next.previous = left;
    }

    return freedSize;
  }

  function capacity(pointer) {
    return requireLiveBlock(pointer).capacity;
  }

  function read(pointer, length) {
    const block = requireLiveBlock(pointer);
    if (length === undefined) length = block.capacity;

    if (!isNonNegativeInteger(length)) {
      throw badArgument('read 的 length 必须是非负整数');
    }
    if (length > block.capacity) {
      throw new HeapError('ERR_OUT_OF_BOUNDS', '读取范围超出分配容量', {
        requested: length,
        capacity: block.capacity,
      });
    }

    return block.data.slice(0, length);
  }

  function write(pointer, data) {
    const block = requireLiveBlock(pointer);

    if (!(data instanceof Uint8Array)) {
      throw badArgument('write 的 data 必须是 Uint8Array');
    }
    if (data.length > block.capacity) {
      throw new HeapError('ERR_OUT_OF_BOUNDS', '写入数据超出分配容量', {
        requested: data.length,
        capacity: block.capacity,
      });
    }

    block.data.set(data);
  }

  function dump() {
    const snapshot = [];
    for (let block = blocks; block !== null; block = block.next) {
      snapshot.push({
        offset: block.offset,
        size: block.size,
        used: block.used,
        capacity: block.capacity,
      });
    }
    return snapshot;
  }

  function stats() {
    let used = 0;
    let freeBytes = 0;
    let blockCount = 0;
    let freeBlockCount = 0;
    let largestFree = 0;

    for (let block = blocks; block !== null; block = block.next) {
      blockCount += 1;
      if (block.used) {
        used += block.size;
      } else {
        freeBytes += block.size;
        freeBlockCount += 1;
        if (block.size > largestFree) largestFree = block.size;
      }
    }

    return {
      size,
      used,
      free: freeBytes,
      blocks: blockCount,
      freeBlocks: freeBlockCount,
      largestFree,
    };
  }

  return {
    alloc,
    free,
    capacity,
    read,
    write,
    dump,
    stats,
  };
}
