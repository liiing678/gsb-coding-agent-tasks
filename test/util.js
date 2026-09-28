import { HeapError } from '../lib/errors.js';

export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof HeapError ? err.code : `NOT_HEAP:${err.message}`;
  }
};

export const details = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.details;
  }
  return null;
};

export const mulberry32 = (seed) => () => {
  let state = (seed += 0x6d2b79f5);
  state = Math.imul(state ^ (state >>> 15), state | 1);
  state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
  return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
};

// 一块地一个字节地记着归谁：用来抓「两次分配叠在一起」这种账
export const createOracle = (size) => {
  const owner = new Array(size).fill(-1);
  return {
    claim(pointer, offset, blockSize) {
      for (let index = 0; index < blockSize; index += 1) {
        if (owner[offset + index] !== -1) return false;
        owner[offset + index] = pointer;
      }
      return true;
    },
    release(pointer, offset, blockSize) {
      for (let index = 0; index < blockSize; index += 1) {
        if (owner[offset + index] !== pointer) return false;
        owner[offset + index] = -1;
      }
      return true;
    },
    freeBytes() {
      return owner.filter((item) => item === -1).length;
    },
    largestFree() {
      let best = 0;
      let run = 0;
      for (const item of owner) {
        run = item === -1 ? run + 1 : 0;
        if (run > best) best = run;
      }
      return best;
    },
  };
};

// dump() 那串块必须正好铺满 [0, size)，而且不许有两个空闲块挨着
export const checkTiling = (dump, size, assert) => {
  let cursor = 0;
  for (const block of dump) {
    assert.equal(block.offset, cursor, '块没接上');
    assert.ok(Number.isInteger(block.size) && block.size > 0, '块大小得是正整数');
    if (block.used) {
      assert.ok(Number.isInteger(block.capacity) && block.capacity >= 0, '占用块的 capacity 得是非负整数');
      assert.ok(block.size >= block.capacity + 8, '占用块得放得下头和内容');
    } else {
      assert.equal(block.capacity, 0, '空闲块的 capacity 得是 0');
    }
    cursor += block.size;
  }
  assert.equal(cursor, size, '块没铺满');
  for (let index = 1; index < dump.length; index += 1) {
    assert.ok(dump[index - 1].used || dump[index].used, '两个空闲块挨在一起没合并');
  }
};