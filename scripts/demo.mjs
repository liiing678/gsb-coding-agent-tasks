import { createRouter } from '../lib/routegraph.js';

const line = (label, value) => console.log(`  ${label} ${value}`);
const show = (label, router, options) => {
  try {
    line(label, JSON.stringify(router.route(options)));
  } catch (err) {
    line(label, err.code);
  }
};

const grid = {
  nodes: ['A', 'B', 'C', 'D'],
  edges: [
    { id: 'e1', from: 'A', to: 'B', length: 60, speed: 60 },
    { id: 'e2', from: 'A', to: 'C', length: 120, speed: 60 },
    { id: 'e3', from: 'B', to: 'D', length: 60, speed: 60 },
    { id: 'e4', from: 'C', to: 'D', length: 30, speed: 60 },
    { id: 'e5', from: 'A', to: 'D', length: 600, speed: 60, closures: [[100, 200]] },
  ],
  turns: [],
};

console.log('routegraph demo');
const router = createRouter(grid);
line('stats', JSON.stringify(router.stats()));
show('basic', router, { from: 'A', to: 'D' });
show('same', router, { from: 'A', to: 'A', departAt: 5 });
show('closure', router, { from: 'A', to: 'D', departAt: 90 });

const wrap = createRouter({
  nodes: ['A', 'B'],
  edges: [{ id: 'x', from: 'A', to: 'B', length: 60, speed: 60, closures: [[86000, 100]] }],
});
show('wrap', wrap, { from: 'A', to: 'B', departAt: 86300 });

const sealed = createRouter({
  nodes: ['A', 'B', 'C'],
  edges: [
    { id: 'x', from: 'A', to: 'B', length: 60, speed: 60, closures: [[10, 10]] },
    { id: 'y', from: 'A', to: 'C', length: 60, speed: 60 },
    { id: 'z', from: 'C', to: 'B', length: 300, speed: 60 },
  ],
});
show('sealed', sealed, { from: 'A', to: 'B' });

const turns = createRouter({
  nodes: ['A', 'B', 'C'],
  edges: [
    { id: 'ab', from: 'A', to: 'B', length: 60, speed: 60 },
    { id: 'bc', from: 'B', to: 'C', length: 60, speed: 60 },
    { id: 'ac', from: 'A', to: 'C', length: 300, speed: 60 },
  ],
  turns: [{ from: 'ab', via: 'B', to: 'bc', kind: 'no' }],
});
show('no-turn', turns, { from: 'A', to: 'C' });

const only = createRouter({
  nodes: ['A', 'B', 'C', 'D'],
  edges: [
    { id: 'ab', from: 'A', to: 'B', length: 60, speed: 60 },
    { id: 'bc', from: 'B', to: 'C', length: 60, speed: 60 },
    { id: 'bd', from: 'B', to: 'D', length: 60, speed: 60 },
    { id: 'ad', from: 'A', to: 'D', length: 240, speed: 60 },
  ],
  turns: [{ from: 'ab', via: 'B', to: 'bc', kind: 'only' }],
});
show('only-turn', only, { from: 'A', to: 'D' });

const tied = createRouter({
  nodes: ['A', 'B', 'C'],
  edges: [
    { id: 'b1', from: 'A', to: 'B', length: 60, speed: 60 },
    { id: 'b2', from: 'B', to: 'C', length: 60, speed: 60 },
    { id: 'a1', from: 'A', to: 'C', length: 120, speed: 60 },
  ],
});
show('tie', tied, { from: 'A', to: 'C' });
show('unreachable', turns, { from: 'C', to: 'A' });
show('missing-node', turns, { from: 'A', to: 'ZZ' });