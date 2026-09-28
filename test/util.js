import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'extmerge-test-'));

export const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

export const runsIn = (dir) => fs.readdirSync(dir).sort();

export const linesIn = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8')
  .split('\n')
  .filter((line) => line !== '');

export const byKey = (left, right) => left.key - right.key;

export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

export const shuffled = (count, seed = 12345) => {
  const out = Array.from({ length: count }, (_, index) => index);
  let state = seed >>> 0;
  for (let at = out.length - 1; at > 0; at -= 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const pick = (state >>> 8) % (at + 1);
    [out[at], out[pick]] = [out[pick], out[at]];
  }
  return out;
};
