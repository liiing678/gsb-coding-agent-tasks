import { createTable } from '../lib/cidrroute.js';

export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

// 一次塞一批前缀，省得每条用例都手写 insert。
export const table = (entries = []) => {
  const t = createTable();
  for (const [prefix, value] of entries) t.insert(prefix, value);
  return t;
};

export const prefixes = (t) => t.entries().map((entry) => entry.prefix);
