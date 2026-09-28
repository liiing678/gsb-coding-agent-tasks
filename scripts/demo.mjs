import {
  compare, createNode, dots, empty, merge, missing, tick,
} from '../lib/vclock.js';

const line = (label, value) => console.log(`  ${label} ${value}`);
const texts = (list) => list.map((dot) => `${dot.id}:${dot.counter}`);

console.log('vclock demo');
line('empty', JSON.stringify(empty()));

const a = createNode('a');
const m1 = a.send('a1');
const m2 = a.send('a2');
line('a.clock', JSON.stringify(a.clock()));
line('m2', JSON.stringify(m2));

const b = createNode('b');
line('b.deliver(m2)', String(b.deliver(m2)));
line('b.pending', String(b.pending().length));
line('b.deliver(m1)', String(b.deliver(m1)));
line('b.clock', JSON.stringify(b.clock()));
line('b.pendingAfter', String(b.pending().length));
line('b.deliver(m2)again', String(b.deliver(m2)));
line('compareAB', compare(a.clock(), b.clock()));

const c = createNode('c');
c.deliver(m1);
c.deliver(m2);
const m3 = c.send('c1');
line('c.clock', JSON.stringify(c.clock()));
line('compareBC', compare(b.clock(), c.clock()));
line('missingBC', JSON.stringify(missing(b.clock(), c.clock())));
line('dotsC', JSON.stringify(texts(dots(c.clock()))));
line('mergeBC', JSON.stringify(merge(b.clock(), c.clock())));
line('tickA', JSON.stringify(tick(a.clock(), 'a')));

const d = createNode('d');
const m4 = d.send('d1');
line('compareCD', compare(c.clock(), d.clock()));
line('c.deliver(m4)', String(c.deliver(m4)));
line('c.clockAfter', JSON.stringify(c.clock()));
line('b.deliver(m3)', String(b.deliver(m3)));
line('b.clockAfter', JSON.stringify(b.clock()));
