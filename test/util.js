import { createNode } from '../lib/vclock.js';

export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

export const node = (id) => createNode(id);

export const dotText = (dot) => `${dot.id}:${dot.counter}`;
export const texts = (list) => list.map(dotText);
