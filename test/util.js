import { createBitmap } from '../lib/roarbit.js';

export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

export const range = (start, count, step = 1) =>
  Array.from({ length: count }, (_, index) => start + index * step);

export const bitmapOf = (values) => {
  const bitmap = createBitmap();
  for (const value of values) bitmap.add(value);
  return bitmap;
};

// 固定种子的洗牌，用来验证「加进去的先后顺序不影响结果」。
export const shuffled = (values, seed) => {
  const out = values.slice();
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = next() % (index + 1);
    const held = out[index];
    out[index] = out[swap];
    out[swap] = held;
  }
  return out;
};
