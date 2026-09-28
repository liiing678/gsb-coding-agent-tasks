// 32 位整数上的 roaring 位图：按高 16 位分桶，桶里要么是有序的数组容器（最多 4096 个值），
// 要么是 2048 个 uint32 的位图容器（正好 65536 位）。
import { RoarbitError } from './errors.js';

const MAX_ARRAY = 4096;
const WORDS = 2048;
const BRAND = Symbol('roarbit');
const ENTRIES = Symbol('roarbit.entries');

const badValue = (value) => {
  throw new RoarbitError('ERR_BAD_VALUE', `值要是 0..4294967295 之间的整数，收到 ${String(value)}`);
};

const badBitmap = (name) => {
  throw new RoarbitError('ERR_BAD_BITMAP', `${name} 得是 createBitmap() 出来的位图`);
};

const checkValue = (value) => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) badValue(value);
  return value;
};

const keyOf = (value) => value >>> 16;
const lowOf = (value) => value & 0xffff;

const emptyWords = () => new Uint32Array(WORDS);

const arrayContainer = (values = []) => ({ kind: 'array', values });
const bitmapContainer = (words = emptyWords()) => ({ kind: 'bitmap', words });

const countBits = (words) => {
  let count = 0;
  for (let index = 0; index < words.length; index += 1) {
    let word = words[index];
    while (word !== 0) {
      count += word & 1;
      word >>>= 1;
    }
  }
  return count;
};

const containerCount = (container) => (
  container.kind === 'array' ? container.values.length : countBits(container.words)
);

const wordsToValues = (words) => {
  const out = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === 0) continue;
    for (let bit = 0; bit < 32; bit += 1) {
      if ((word >>> bit) & 1) out.push(index * 32 + bit);
    }
  }
  return out;
};

const valuesToWords = (values) => {
  const words = emptyWords();
  for (const low of values) words[low >>> 5] |= 1 << (low & 31);
  return words;
};

const wordHas = (words, low) => ((words[low >>> 5] >>> (low & 31)) & 1) === 1;
const wordSet = (words, low) => {
  words[low >>> 5] = (words[low >>> 5] | (1 << (low & 31))) >>> 0;
};
const wordClear = (words, low) => {
  words[low >>> 5] = (words[low >>> 5] & ~(1 << (low & 31))) >>> 0;
};

const lowerBound = (values, low) => {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < low) lo = mid + 1; else hi = mid;
  }
  return lo;
};

// 容器类型就这四种组合里定死的：一个桶的值不超过 4096 个必须是数组容器，
// 超过 4096（也就是 4097 个起）必须是位图容器。任何改动过桶内容的动作都得过一遍。
const settle = (container) => {
  if (container.kind === 'array') {
    if (container.values.length <= MAX_ARRAY) return container;
    return bitmapContainer(valuesToWords(container.values));
  }
  if (countBits(container.words) > MAX_ARRAY) return container;
  return arrayContainer(wordsToValues(container.words));
};

const containerHas = (container, low) => {
  if (container.kind === 'bitmap') return wordHas(container.words, low);
  const index = lowerBound(container.values, low);
  return index < container.values.length && container.values[index] === low;
};

const containerAdd = (container, low) => {
  if (container.kind === 'bitmap') {
    if (wordHas(container.words, low)) return false;
    wordSet(container.words, low);
    return true;
  }
  const index = lowerBound(container.values, low);
  if (index < container.values.length && container.values[index] === low) return false;
  container.values.splice(index, 0, low);
  return true;
};

const containerRemove = (container, low) => {
  if (container.kind === 'bitmap') {
    if (!wordHas(container.words, low)) return false;
    wordClear(container.words, low);
    return true;
  }
  const index = lowerBound(container.values, low);
  if (index >= container.values.length || container.values[index] !== low) return false;
  container.values.splice(index, 1);
  return true;
};

const copyContainer = (container) => (container.kind === 'array'
  ? arrayContainer(container.values.slice())
  : bitmapContainer(Uint32Array.from(container.words)));

const copyEntry = (entry) => ({ key: entry.key, container: copyContainer(entry.container) });

const bothArrays = (left, right, step) => {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (j >= right.length || (i < left.length && left[i] < right[j])) {
      if (step !== 'and') out.push(left[i]);
      i += 1;
    } else if (i >= left.length || right[j] < left[i]) {
      if (step !== 'and') out.push(right[j]);
      j += 1;
    } else if (step === 'and') {
      out.push(left[i]);
      i += 1;
      j += 1;
    } else if (step === 'or') {
      out.push(left[i]);
      i += 1;
      j += 1;
    } else {
      i += 1;
      j += 1;
    }
  }
  return out;
};

const andContainers = (left, right) => {
  if (left.kind === 'array' && right.kind === 'array') {
    return arrayContainer(bothArrays(left.values, right.values, 'and'));
  }
  if (left.kind === 'bitmap' && right.kind === 'bitmap') {
    const words = emptyWords();
    for (let index = 0; index < WORDS; index += 1) words[index] = left.words[index] & right.words[index];
    return settle(bitmapContainer(words));
  }
  const bitmap = left.kind === 'bitmap' ? left : right;
  const array = left.kind === 'bitmap' ? right : left;
  const out = [];
  for (const low of array.values) if (wordHas(bitmap.words, low)) out.push(low);
  return arrayContainer(out);
};

const orContainers = (left, right) => {
  if (left.kind === 'array' && right.kind === 'array') {
    return settle(arrayContainer(bothArrays(left.values, right.values, 'or')));
  }
  if (left.kind === 'bitmap' && right.kind === 'bitmap') {
    const words = emptyWords();
    for (let index = 0; index < WORDS; index += 1) words[index] = (left.words[index] | right.words[index]) >>> 0;
    return bitmapContainer(words);
  }
  const bitmap = left.kind === 'bitmap' ? left : right;
  const array = left.kind === 'bitmap' ? right : left;
  const words = Uint32Array.from(bitmap.words);
  for (const low of array.values) wordSet(words, low);
  return bitmapContainer(words);
};

const xorContainers = (left, right) => {
  if (left.kind === 'array' && right.kind === 'array') {
    return settle(arrayContainer(bothArrays(left.values, right.values, 'xor')));
  }
  if (left.kind === 'bitmap' && right.kind === 'bitmap') {
    const words = emptyWords();
    for (let index = 0; index < WORDS; index += 1) words[index] = (left.words[index] ^ right.words[index]) >>> 0;
    return settle(bitmapContainer(words));
  }
  const bitmap = left.kind === 'bitmap' ? left : right;
  const array = left.kind === 'bitmap' ? right : left;
  const words = Uint32Array.from(bitmap.words);
  for (const low of array.values) {
    if (wordHas(words, low)) wordClear(words, low); else wordSet(words, low);
  }
  return settle(bitmapContainer(words));
};

const STEPS = { and: andContainers, or: orContainers, xor: xorContainers };

// 按 key 升序的 [{ key, container }]，空桶不留。
const locate = (entries, key) => {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].key < key) lo = mid + 1; else hi = mid;
  }
  return lo;
};

const at = (entries, key) => {
  const index = locate(entries, key);
  return index < entries.length && entries[index].key === key ? index : -1;
};

const combine = (left, right, step) => {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (j >= right.length || (i < left.length && left[i].key < right[j].key)) {
      if (step !== 'and') out.push(copyEntry(left[i]));
      i += 1;
    } else if (i >= left.length || right[j].key < left[i].key) {
      if (step !== 'and') out.push(copyEntry(right[j]));
      j += 1;
    } else {
      const container = STEPS[step](left[i].container, right[j].container);
      if (containerCount(container) > 0) out.push({ key: left[i].key, container });
      i += 1;
      j += 1;
    }
  }
  return out;
};

const sameContainer = (left, right) => {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'array') {
    if (left.values.length !== right.values.length) return false;
    return left.values.every((low, index) => low === right.values[index]);
  }
  for (let index = 0; index < WORDS; index += 1) if (left.words[index] !== right.words[index]) return false;
  return true;
};

const wrap = (entries) => {
  const api = {
    add(value) {
      checkValue(value);
      const key = keyOf(value);
      const index = at(entries, key);
      if (index < 0) {
        entries.splice(locate(entries, key), 0, { key, container: arrayContainer([lowOf(value)]) });
        return true;
      }
      if (!containerAdd(entries[index].container, lowOf(value))) return false;
      entries[index] = { key, container: settle(entries[index].container) };
      return true;
    },
    remove(value) {
      checkValue(value);
      const key = keyOf(value);
      const index = at(entries, key);
      if (index < 0) return false;
      if (!containerRemove(entries[index].container, lowOf(value))) return false;
      const container = entries[index].container;
      if (containerCount(container) === 0) entries.splice(index, 1);
      else entries[index] = { key, container: settle(container) };
      return true;
    },
    has(value) {
      checkValue(value);
      const index = at(entries, keyOf(value));
      return index >= 0 && containerHas(entries[index].container, lowOf(value));
    },
    size() {
      let total = 0;
      for (const entry of entries) total += containerCount(entry.container);
      return total;
    },
    toArray() {
      const out = [];
      for (const entry of entries) {
        const base = entry.key * 65536;
        if (entry.container.kind === 'array') {
        const { values } = entry.container;
        for (let index = 0; index < values.length; index += 1) out.push(base + values[index]);
        } else {
          for (const low of wordsToValues(entry.container.words)) out.push(base + low);
        }
      }
      return out;
    },
    containers() {
      return entries.map((entry) => ({
        key: entry.key,
        kind: entry.container.kind,
        count: containerCount(entry.container),
      }));
    },
    clone() {
      return wrap(entries.map(copyEntry));
    },
  };
  Object.defineProperty(api, BRAND, { value: true });
  Object.defineProperty(api, ENTRIES, { value: entries });
  return api;
};

const entriesOf = (value, name) => {
  if (!value || typeof value !== 'object' || value[BRAND] !== true) badBitmap(name);
  return value[ENTRIES];
};

export function createBitmap() {
  return wrap([]);
}

export function and(left, right) {
  return wrap(combine(entriesOf(left, 'and 的第一个参数'), entriesOf(right, 'and 的第二个参数'), 'and'));
}

export function or(left, right) {
  return wrap(combine(entriesOf(left, 'or 的第一个参数'), entriesOf(right, 'or 的第二个参数'), 'or'));
}

export function xor(left, right) {
  return wrap(combine(entriesOf(left, 'xor 的第一个参数'), entriesOf(right, 'xor 的第二个参数'), 'xor'));
}

export function equals(left, right) {
  const a = entriesOf(left, 'equals 的第一个参数');
  const b = entriesOf(right, 'equals 的第二个参数');
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index].key !== b[index].key) return false;
    if (!sameContainer(a[index].container, b[index].container)) return false;
  }
  return true;
}
