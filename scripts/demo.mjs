import { and, createBitmap, equals, or, xor } from '../lib/roarbit.js';

const line = (label, value) => console.log(`  ${label} ${value}`);
const range = (start, count) => Array.from({ length: count }, (_, index) => start + index);

console.log('roarbit demo');

const small = createBitmap();
for (const value of [3, 70000, 1, 3]) small.add(value);
line('small.size', String(small.size()));
line('small.toArray', JSON.stringify(small.toArray()));
line('small.containers', JSON.stringify(small.containers()));

const wide = createBitmap();
for (const value of range(0, 5000)) wide.add(value);
line('wide.size', String(wide.size()));
line('wide.containers', JSON.stringify(wide.containers()));
for (const value of range(0, 1000)) wide.remove(value);
line('wide.afterRemove', JSON.stringify(wide.containers()));

const left = createBitmap();
for (const value of range(0, 3000)) left.add(value);
const right = createBitmap();
for (const value of range(2500, 3000)) right.add(value);
line('and', String(and(left, right).size()));
line('or', String(or(left, right).size()));
line('or.containers', JSON.stringify(or(left, right).containers()));
line('xor.head', JSON.stringify(xor(left, right).toArray().slice(0, 4)));
line('xor.size', String(xor(left, right).size()));
line('equals', String(equals(or(left, right), or(right, left))));
line('left.untouched', String(left.size()));

const high = createBitmap();
high.add(4294967295);
high.add(0);
line('high.toArray', JSON.stringify(high.toArray()));
line('high.has', String(high.has(4294967295)));
