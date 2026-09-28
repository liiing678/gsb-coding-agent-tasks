import test from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../lib/routegraph.js';
import { close, mulberry32, simplePaths, simulate } from './util.js';

const grid = () => ({
  nodes: ['A', 'B', 'C', 'D'],
  edges: [
    { id: 'e1', from: 'A', to: 'B', length: 60, speed: 60 },
    { id: 'e2', from: 'A', to: 'C', length: 120, speed: 60 },
    { id: 'e3', from: 'B', to: 'D', length: 60, speed: 60 },
    { id: 'e4', from: 'C', to: 'D', length: 30, speed: 60 },
    { id: 'e5', from: 'A', to: 'D', length: 600, speed: 60, closures: [[100, 200]] },
  ],
  turns: [],
});

test('基本最短路与返回形状', () => {
  const router = createRouter(grid());
  assert.deepEqual(router.stats(), { nodes: 4, edges: 5, turns: 0 });
  assert.deepEqual(router.route({ from: 'A', to: 'D' }), { arrive: 2, seconds: 2, path: ['e1', 'e3'] });
  assert.deepEqual(router.route({ from: 'A', to: 'C' }), { arrive: 2, seconds: 2, path: ['e2'] });
  assert.deepEqual(router.route({ from: 'A', to: 'B', departAt: 10 }),
    { arrive: 11, seconds: 1, path: ['e1'] });
  assert.deepEqual(router.route({ from: 'A', to: 'A', departAt: 5 }), { arrive: 5, seconds: 0, path: [] });
  const fastest = createRouter({
    nodes: ['A', 'B'],
    edges: [{ id: 'slow', from: 'A', to: 'B', length: 100, speed: 10 },
      { id: 'fast', from: 'A', to: 'B', length: 1000, speed: 1000 }],
  });
  assert.deepEqual(fastest.route({ from: 'A', to: 'B' }), { arrive: 1, seconds: 1, path: ['fast'] });
});

test('到达时刻一样时取边 id 序列字典序最小的', () => {
  const tied = createRouter({
    nodes: ['A', 'B', 'C'],
    edges: [
      { id: 'b1', from: 'A', to: 'B', length: 60, speed: 60 },
      { id: 'b2', from: 'B', to: 'C', length: 60, speed: 60 },
      { id: 'a1', from: 'A', to: 'C', length: 120, speed: 60 },
    ],
  });
  assert.deepEqual(tied.route({ from: 'A', to: 'C' }), { arrive: 2, seconds: 2, path: ['a1'] });
  const other = createRouter({
    nodes: ['A', 'B', 'C'],
    edges: [
      { id: 'z9', from: 'A', to: 'C', length: 120, speed: 60 },
      { id: 'a1', from: 'A', to: 'B', length: 60, speed: 60 },
      { id: 'a2', from: 'B', to: 'C', length: 60, speed: 60 },
    ],
  });
  assert.deepEqual(other.route({ from: 'A', to: 'C' }).path, ['a1', 'a2']);
  // 前缀相同就比长度：a1 比 a1,a2 小
  assert.equal(other.route({ from: 'A', to: 'B' }).path.length, 1);
});

test('封路与等待', () => {
  const router = createRouter(grid());
  assert.deepEqual(router.route({ from: 'A', to: 'D', departAt: 90 }),
    { arrive: 92, seconds: 2, path: ['e1', 'e3'] });
  const only = createRouter({
    nodes: ['A', 'B'],
    edges: [{ id: 'x', from: 'A', to: 'B', length: 60, speed: 60, closures: [[100, 200]] }],
  });
  // 还没到封路时间就照常走
  assert.deepEqual(only.route({ from: 'A', to: 'B', departAt: 50 }),
    { arrive: 51, seconds: 1, path: ['x'] });
  assert.deepEqual(only.route({ from: 'A', to: 'B', departAt: 99 }),
    { arrive: 100, seconds: 1, path: ['x'] });
  // 落在封路里就等到结束：开始那一刻也算在里面，结束那一刻不算
  assert.deepEqual(only.route({ from: 'A', to: 'B', departAt: 100 }),
    { arrive: 201, seconds: 101, path: ['x'] });
  assert.deepEqual(only.route({ from: 'A', to: 'B', departAt: 150 }),
    { arrive: 201, seconds: 51, path: ['x'] });
  assert.deepEqual(only.route({ from: 'A', to: 'B', departAt: 200 }),
    { arrive: 201, seconds: 1, path: ['x'] });
  // 跨零点
  const wrap = createRouter({
    nodes: ['A', 'B'],
    edges: [{ id: 'x', from: 'A', to: 'B', length: 60, speed: 60, closures: [[86000, 100]] }],
  });
  assert.deepEqual(wrap.route({ from: 'A', to: 'B', departAt: 50 }), { arrive: 101, seconds: 51, path: ['x'] });
  // 100 是封路的结束那一刻，不算封着
  assert.deepEqual(wrap.route({ from: 'A', to: 'B', departAt: 100 }), { arrive: 101, seconds: 1, path: ['x'] });
  assert.deepEqual(wrap.route({ from: 'A', to: 'B', departAt: 200 }), { arrive: 201, seconds: 1, path: ['x'] });
  // 晚上那段封路里出发，得等过零点、封路结束才走得了
  assert.deepEqual(wrap.route({ from: 'A', to: 'B', departAt: 86400 }), { arrive: 86501, seconds: 101, path: ['x'] });
  assert.deepEqual(wrap.route({ from: 'A', to: 'B', departAt: 86300 }), { arrive: 86501, seconds: 201, path: ['x'] });
  // 跨过零点之后出发，当天那段封路早就结束了
  assert.deepEqual(wrap.route({ from: 'A', to: 'B', departAt: 87000 }), { arrive: 87001, seconds: 1, path: ['x'] });
  // 开始等于结束就是整天封
  const sealed = createRouter({
    nodes: ['A', 'B', 'C'],
    edges: [
      { id: 'x', from: 'A', to: 'B', length: 60, speed: 60, closures: [[10, 10]] },
      { id: 'y', from: 'A', to: 'C', length: 60, speed: 60 },
      { id: 'z', from: 'C', to: 'B', length: 300, speed: 60 },
    ],
  });
  assert.deepEqual(sealed.route({ from: 'A', to: 'B' }), { arrive: 6, seconds: 6, path: ['y', 'z'] });
});

test('转弯限制', () => {
  const noTurn = createRouter({
    nodes: ['A', 'B', 'C'],
    edges: [
      { id: 'ab', from: 'A', to: 'B', length: 60, speed: 60 },
      { id: 'bc', from: 'B', to: 'C', length: 60, speed: 60 },
      { id: 'ac', from: 'A', to: 'C', length: 300, speed: 60 },
    ],
    turns: [{ from: 'ab', via: 'B', to: 'bc', kind: 'no' }],
  });
  assert.deepEqual(noTurn.route({ from: 'A', to: 'C' }), { arrive: 5, seconds: 5, path: ['ac'] });
  assert.deepEqual(noTurn.route({ from: 'A', to: 'B' }), { arrive: 1, seconds: 1, path: ['ab'] });

  const onlyTurn = createRouter({
    nodes: ['A', 'B', 'C', 'D'],
    edges: [
      { id: 'ab', from: 'A', to: 'B', length: 60, speed: 60 },
      { id: 'bc', from: 'B', to: 'C', length: 60, speed: 60 },
      { id: 'bd', from: 'B', to: 'D', length: 60, speed: 60 },
      { id: 'ad', from: 'A', to: 'D', length: 240, speed: 60 },
    ],
    turns: [{ from: 'ab', via: 'B', to: 'bc', kind: 'only' }],
  });
  assert.deepEqual(onlyTurn.route({ from: 'A', to: 'D' }), { arrive: 4, seconds: 4, path: ['ad'] });
  assert.deepEqual(onlyTurn.route({ from: 'A', to: 'C' }), { arrive: 2, seconds: 2, path: ['ab', 'bc'] });

  const uTurn = createRouter({
    nodes: ['A', 'B'],
    edges: [
      { id: 'ab', from: 'A', to: 'B', length: 60, speed: 60 },
      { id: 'ba', from: 'B', to: 'A', length: 60, speed: 60 },
    ],
    turns: [{ from: 'ab', via: 'B', to: 'ba', kind: 'no' }],
  });
  assert.deepEqual(uTurn.route({ from: 'A', to: 'B' }), { arrive: 1, seconds: 1, path: ['ab'] });
  assert.equal(uTurn.route({ from: 'B', to: 'A' }).path[0], 'ba');
});

test('起终点相同、不可达与单向图', () => {
  const oneWay = createRouter({
    nodes: ['A', 'B'],
    edges: [{ id: 'ab', from: 'A', to: 'B', length: 60, speed: 60 }],
  });
  assert.deepEqual(oneWay.route({ from: 'A', to: 'B' }), { arrive: 1, seconds: 1, path: ['ab'] });
  assert.equal(oneWay.route({ from: 'B', to: 'A' }), null);
  assert.deepEqual(oneWay.route({ from: 'B', to: 'B' }), { arrive: 0, seconds: 0, path: [] });
  const island = createRouter({
    nodes: ['A', 'B', 'C'],
    edges: [{ id: 'ab', from: 'A', to: 'B', length: 60, speed: 60 }],
  });
  assert.equal(island.route({ from: 'A', to: 'C' }), null);
  const sealed = createRouter({
    nodes: ['A', 'B'],
    edges: [{ id: 'ab', from: 'A', to: 'B', length: 60, speed: 60, closures: [[0, 0]] }],
  });
  assert.equal(sealed.route({ from: 'A', to: 'B' }), null);
});

test('随机图上对答案：路线得走得通，而且不比任何简单路径差', () => {
  for (let round = 0; round < 40; round += 1) {
    const random = mulberry32(round * 7919 + 13);
    const nodes = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
    const edges = [];
    let counter = 0;
    for (const from of nodes) {
      for (const to of nodes) {
        if (from === to || random() > 0.45) continue;
        const closures = random() > 0.75
          ? [[Math.floor(random() * 400), Math.floor(random() * 400) + 100]]
          : [];
        edges.push({
          id: `e${counter.toString().padStart(2, '0')}`,
          from,
          to,
          length: 60 + Math.floor(random() * 600),
          speed: 60,
          closures,
        });
        counter += 1;
      }
    }
    const turns = [];
    for (const edge of edges) {
      if (random() > 0.8) {
        const other = edges[Math.floor(random() * edges.length)];
        turns.push({ from: edge.id, via: edge.to, to: other.id, kind: random() > 0.5 ? 'no' : 'only' });
      }
    }
    const data = { nodes, edges, turns };
    const router = createRouter(data);
    const departAt = Math.floor(random() * 200);
    const result = router.route({ from: 'n0', to: 'n5', departAt });
    const best = simplePaths(data, 'n0', 'n5')
      .map((path) => simulate(data, 'n0', path, departAt))
      .filter((value) => value !== null)
      .reduce((min, value) => Math.min(min, value.arrive), Infinity);
    if (result === null) {
      assert.equal(best, Infinity, `第 ${round} 轮说有路却返回 null`);
      continue;
    }
    const walked = simulate(data, 'n0', result.path, departAt);
    assert.ok(walked !== null, `第 ${round} 轮的路线走不通`);
    assert.equal(walked.node, 'n5');
    assert.ok(close(walked.arrive, result.arrive), `第 ${round} 轮到达时刻对不上`);
    assert.ok(close(result.seconds, result.arrive - departAt));
    assert.ok(result.arrive <= best + 1e-9, `第 ${round} 轮比简单路径还慢`);
  }
});
