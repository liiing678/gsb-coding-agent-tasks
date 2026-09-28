import { createBuffer } from '../lib/pagetable.js';

export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

export const buffer = (text) => createBuffer(text);

// 只关心「这一串操作之后长什么样」时用它。
export const applied = (text, edits) => {
  const buf = createBuffer(text);
  for (const edit of edits) edit(buf);
  return buf;
};
