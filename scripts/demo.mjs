import { createHeap } from '../lib/heapfit.js';

const line = (label, value) => console.log(`  ${label} ${value}`);
const show = (label, fn) => {
  try {
    line(label, JSON.stringify(fn()));
  } catch (err) {
    line(label, err.code);
  }
};

console.log('heapfit demo');
const heap = createHeap({ size: 256 });
line('fresh', JSON.stringify(heap.stats()));
const zero = heap.alloc(0);
const small = heap.alloc(8);
const bigger = heap.alloc(24);
line('pointers', JSON.stringify([zero, small, bigger]));
line('dump', JSON.stringify(heap.dump()));
line('stats', JSON.stringify(heap.stats()));
heap.write(small, new Uint8Array([9, 2, 3]));
line('read', JSON.stringify([...heap.read(small)]));
line('read-short', JSON.stringify([...heap.read(small, 2)]));
try {
  heap.write(bigger, new Uint8Array(25));
} catch (err) {
  line('oob', JSON.stringify([err.code, err.details]));
}
line('free', JSON.stringify(heap.free(small)));
show('double-free', () => heap.free(small));
line('after-free', JSON.stringify(heap.dump()));

const build = (strategy) => {
  const h = createHeap({ size: 512, strategy });
  const big = h.alloc(400);
  const mid = h.alloc(40);
  const spare = h.alloc(8);
  h.free(big);
  h.free(spare);
  return h;
};
line('best-fit', JSON.stringify(build('best').alloc(8)));
line('first-fit', JSON.stringify(build('first').alloc(8)));

const tight = createHeap({ size: 100 });
tight.alloc(80);
line('no-split', JSON.stringify(tight.dump()));
show('out-of-memory', () => tight.alloc(1));