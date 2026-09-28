import test from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../lib/routegraph.js';
import { close, code, mulberry32, simulate } from './util.js';

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

test('入参校验：图本身', () => {
  for (const data of [null, undefined, 7, 'x', [], true]) {
    assert.equal(code(() => createRouter(data)), 'ERR_BAD_ARGUMENT');
  }
  assert.equal(code(() => createRouter({ nodes: ['A'], edges: {}, turns: [] })), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => createRouter({ nodes: ['A'], edges: [], turns: 'x' })), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => createRouter({ nodes: [7], edges: [] })), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => createRouter({ nodes: [''] })), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => createRouter({ nodes: ['A', 'A'], edges: [] })), 'ERR_BAD_ARGUMENT');
  const good = { id: 'ab', from: 'A', to: 'B', length: 60, speed: 60 };
  assert.equal(code(() => createRouter({ nodes: ['A', 'B'], edges: ['x'] })), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => createRouter({ nodes: ['A', 'B'], edges: [{ ...good, id: '' }] })), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => createRouter({ nodes: ['A', 'B'], edges: [good, { ...good }] })), 'ERR_BAD_ARGUMENT');
  for (const bad of [{ length: 0 }, { length: -1 }, { length: NaN }, { length: Infinity },
    { length: '60' }, { speed: 0 }, { speed: null }, { speed: -60 }]) {
    assert.equal(code(() => createRouter({ nodes: ['A', 'B'], edges: [{ ...good, ...bad }] })), 'ERR_BAD_ARGUMENT');
  }
  // 边可以很长 / 很慢 / 时长是小数
  assert.equal(code(() => createRouter({ nodes: ['A', 'B'], edges: [{ ...good, length: 100, speed: 30 }] })), null);
  assert.equal(code(() => createRouter({ nodes: ['A', 'B'], edges: [{ ...good, length: 1, speed: 3 }] })), null);
  assert.equal(code(() => createRouter({ nodes: ['A', 'B'], edges: [{ ...good, closures: undefined }] })), null);
  // 边引用了没声明的节点
  try {
    createRouter({ nodes: ['A', 'B'], edges: [{ ...good, to: 'ZZ' }] });
    assert.fail('该抛 ERR_UNKNOWN_NODE');
  } catch (err) {
    assert.equal(err.code, 'ERR_UNKNOWN_NODE');
    assert.deepEqual(err.details, { edge: 'ab' });
  }
});

test('入参校验：封路区间与转弯限制', () => {
  const nodes = ['A', 'B', 'C'];
  const edges = [
    { id: 'ab', from: 'A', to: 'B', length: 60, speed: 60 },
    { id: 'bc', from: 'B', to: 'C', length: 60, speed: 60 },
  ];
  const withClosures = (closures) => () =>
    createRouter({ nodes, edges: [{ ...edges[0], closures }, edges[1]] });
  for (const closures of ['x', 7, null, {}, [[1]], [[1, 2, 3]], [[1, '2']], [[-1, 5]],
    [[0, 86401]], [[NaN, 5]], [[Infinity, 5]], [[0, 0, 0]]]) {
    assert.equal(code(withClosures(closures)), 'ERR_BAD_ARGUMENT');
  }
  for (const closures of [[], undefined, [[0, 0]], [[0, 86400]], [[86400, 0]], [[86399, 1]]]) {
    assert.equal(code(withClosures(closures)), null);
  }
  const turnRouter = (turns) => () => createRouter({ nodes, edges, turns });
  for (const turns of [null, 'x', [1], [[]], [null]]) {
    assert.equal(code(turnRouter(turns)), 'ERR_BAD_ARGUMENT');
  }
  for (const kind of ['NO', 'noo', '', null, 7, undefined]) {
    assert.equal(code(turnRouter([{ from: 'ab', via: 'B', to: 'bc', kind }])), 'ERR_BAD_ARGUMENT');
  }
  for (const turn of [{ from: 'zz', via: 'B', to: 'bc', kind: 'no' },
    { from: 'ab', via: 'B', to: 'zz', kind: 'no' },
    { from: 'ab', via: 'ZZ', to: 'bc', kind: 'only' }]) {
    assert.equal(code(turnRouter([turn])), 'ERR_UNKNOWN_NODE');
  }
  assert.equal(code(turnRouter([])), null);
  assert.equal(code(turnRouter([{ from: 'ab', via: 'B', to: 'bc', kind: 'no' }])), null);
});

test('入参校验：route 的参数', () => {
  const router = createRouter(grid());
  for (const options of [null, 7, 'x', [], true]) {
    assert.equal(code(() => router.route(options)), 'ERR_BAD_ARGUMENT');
  }
  // 不传就是空对象，缺 from / to 直接算「没这个节点」
  assert.equal(code(() => router.route()), 'ERR_UNKNOWN_NODE');
  assert.equal(code(() => router.route({})), 'ERR_UNKNOWN_NODE');
  assert.equal(code(() => router.route({ from: 'A' })), 'ERR_UNKNOWN_NODE');
  assert.equal(code(() => router.route({ from: 'A', to: 'ZZ' })), 'ERR_UNKNOWN_NODE');
  assert.equal(code(() => router.route({ from: 'ZZ', to: 'D' })), 'ERR_UNKNOWN_NODE');
  try {
    router.route({ from: 'ZZ', to: 'D' });
    assert.fail('该抛 ERR_UNKNOWN_NODE');
  } catch (err) {
    assert.deepEqual(err.details, { node: 'ZZ' });
  }
  for (const departAt of [-1, NaN, Infinity, -Infinity, '0', null, {}, []]) {
    assert.equal(code(() => router.route({ from: 'A', to: 'D', departAt })), 'ERR_BAD_ARGUMENT');
  }
  assert.equal(code(() => router.route({ from: 'A', to: 'D', departAt: undefined })), null);
  assert.equal(code(() => router.route({ from: 'A', to: 'D', departAt: 0 })), null);
  // 起点就是终点：不看封路也不看转弯，零秒零条边
  assert.deepEqual(router.route({ from: 'A', to: 'A', departAt: 12 }), { arrive: 12, seconds: 0, path: [] });
});

test('从起点迈出去的第一条边不受转弯限制管', () => {
  const data = {
    nodes: ['A', 'B', 'C'],
    edges: [
      { id: 'ab', from: 'A', to: 'B', length: 60, speed: 60 },
      { id: 'bc', from: 'B', to: 'C', length: 60, speed: 60 },
      { id: 'cb', from: 'C', to: 'B', length: 60, speed: 60 },
    ],
    // 第一条边 ab 老是被 via B 的 only 挡着，但它前面根本没有边
    turns: [
      { from: 'cb', via: 'B', to: 'bc', kind: 'only' },
      { from: 'cb', via: 'B', to: 'ab', kind: 'no' },
    ],
  };
  const router = createRouter(data);
  assert.deepEqual(router.route({ from: 'A', to: 'C' }), { arrive: 2, seconds: 2, path: ['ab', 'bc'] });
  assert.deepEqual(router.route({ from: 'A', to: 'B' }), { arrive: 1, seconds: 1, path: ['ab'] });
  // 从 C 出发：cb 之后只许接 bc，接 ab 被否掉，所以回不了 A
  assert.equal(router.route({ from: 'C', to: 'A' }), null);
  assert.deepEqual(router.route({ from: 'C', to: 'C' }), { arrive: 0, seconds: 0, path: [] });
  // via 跟 from 那条边的终点对不上时，这条限制就是摆设
  const elsewhere = createRouter({
    nodes: ['A', 'B', 'C'],
    edges: [
      { id: 'ab', from: 'A', to: 'B', length: 60, speed: 60 },
      { id: 'bc', from: 'B', to: 'C', length: 60, speed: 60 },
    ],
    turns: [{ from: 'ab', via: 'C', to: 'bc', kind: 'no' }],
  });
  assert.deepEqual(elsewhere.route({ from: 'A', to: 'C' }), { arrive: 2, seconds: 2, path: ['ab', 'bc'] });
});

test('封路的边界与整天封', () => {
  const single = (closures) => createRouter({
    nodes: ['A', 'B'],
    edges: [{ id: 'x', from: 'A', to: 'B', length: 60, speed: 60, closures }],
  });
  const go = (closures, departAt) => single(closures).route({ from: 'A', to: 'B', departAt });
  // 整天封：start 等于 end，或者区间把一天盖满
  assert.equal(go([[0, 0]], 0), null);
  assert.equal(go([[0, 0]], 43200), null);
  assert.equal(go([[600, 600]], 599), null);
  assert.equal(go([[0, 86400]], 0), null);
  assert.equal(go([[0, 86400]], 43200), null);
  // 开始那一刻算封着，结束那一刻不算
  assert.deepEqual(go([[100, 200]], 99), { arrive: 100, seconds: 1, path: ['x'] });
  assert.deepEqual(go([[100, 200]], 100), { arrive: 201, seconds: 101, path: ['x'] });
  assert.deepEqual(go([[100, 200]], 199), { arrive: 201, seconds: 2, path: ['x'] });
  assert.deepEqual(go([[100, 200]], 200), { arrive: 201, seconds: 1, path: ['x'] });
  // 几段挨着的封路，得一路等到最后一段结束；声明顺序不影响结果
  assert.deepEqual(go([[100, 200], [150, 300]], 120), { arrive: 301, seconds: 181, path: ['x'] });
  assert.deepEqual(go([[150, 300], [100, 200]], 120), { arrive: 301, seconds: 181, path: ['x'] });
  // 跨零点：晚上封到第二天凌晨
  assert.deepEqual(go([[86000, 100]], 85999), { arrive: 86000, seconds: 1, path: ['x'] });
  assert.deepEqual(go([[86000, 100]], 86000), { arrive: 86501, seconds: 501, path: ['x'] });
  assert.deepEqual(go([[86000, 100]], 86399), { arrive: 86501, seconds: 102, path: ['x'] });
  assert.deepEqual(go([[86000, 100]], 86400), { arrive: 86501, seconds: 101, path: ['x'] });
  assert.deepEqual(go([[86000, 100]], 86500), { arrive: 86501, seconds: 1, path: ['x'] });
  // 出发时刻可以远远超过一天，日秒照样折回去
  assert.deepEqual(go([[86000, 100]], 172700), { arrive: 172901, seconds: 201, path: ['x'] });
  assert.equal(go([[0, 0]], 1e9), null);
});

test('edges / stats 与无状态', () => {
  const router = createRouter(grid());
  assert.deepEqual(router.stats(), { nodes: 4, edges: 5, turns: 0 });
  const listed = router.edges();
  assert.equal(listed.length, 5);
  assert.deepEqual(listed.map((edge) => edge.id), ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.deepEqual(listed[0], { id: 'e1', from: 'A', to: 'B', length: 60, speed: 60, seconds: 1, closures: [] });
  assert.ok(close(listed[4].seconds, 10));
  assert.deepEqual(listed[4].closures, [[100, 200]]);
  // 拿到的是一份拷贝，改了不影响内部
  listed[0].length = 9999;
  listed[4].closures.push([0, 10]);
  assert.equal(router.edges()[0].length, 60);
  assert.deepEqual(router.edges()[4].closures, [[100, 200]]);
  assert.deepEqual(router.route({ from: 'A', to: 'D' }), { arrive: 2, seconds: 2, path: ['e1', 'e3'] });
  // 同一份源码要能反复问，答案得一样
  const first = JSON.stringify(router.route({ from: 'A', to: 'D', departAt: 150 }));
  for (let round = 0; round < 5; round += 1) {
    assert.equal(JSON.stringify(router.route({ from: 'A', to: 'D', departAt: 150 })), first);
  }
  assert.deepEqual(router.route({ from: 'A', to: 'D', departAt: 150 }), { arrive: 152, seconds: 2, path: ['e1', 'e3'] });
  // 两个 router 各算各的
  const other = createRouter(grid());
  assert.deepEqual(other.stats(), router.stats());
  assert.deepEqual(other.route({ from: 'A', to: 'D' }), router.route({ from: 'A', to: 'D' }));
});

test('大图上跑得动，而且跟朴素模拟对得上', () => {
  const nodes = [];
  for (let index = 0; index < 200; index += 1) nodes.push(`n${index}`);
  const random = mulberry32(20260924);
  const edges = [];
  let counter = 0;
  for (const from of nodes) {
    for (let step = 0; step < 3; step += 1) {
      const to = nodes[Math.floor(random() * nodes.length)];
      if (to === from) continue;
      const closures = random() > 0.7
        ? [[Math.floor(random() * 800), Math.floor(random() * 800) + 200]]
        : [];
      edges.push({
        id: `e${counter.toString().padStart(3, '0')}`,
        from,
        to,
        length: 30 + Math.floor(random() * 900),
        speed: 30 + Math.floor(random() * 90),
        closures,
      });
      counter += 1;
    }
  }
  const turns = [];
  for (const edge of edges) {
    if (random() > 0.9) {
      const other = edges[Math.floor(random() * edges.length)];
      turns.push({ from: edge.id, via: edge.to, to: other.id, kind: random() > 0.5 ? 'no' : 'only' });
    }
  }
  const data = { nodes, edges, turns };
  const router = createRouter(data);
  assert.deepEqual(router.stats(), { nodes: 200, edges: edges.length, turns: turns.length });
  const started = Date.now();
  for (let round = 0; round < 60; round += 1) {
    const from = nodes[Math.floor(random() * nodes.length)];
    const to = nodes[Math.floor(random() * nodes.length)];
    const departAt = Math.floor(random() * 5000);
    const result = router.route({ from, to, departAt });
    const again = router.route({ from, to, departAt });
    assert.deepEqual(again, result);
    if (from === to) continue;
    if (result === null) continue;
    const walked = simulate(data, from, result.path, departAt);
    assert.ok(walked !== null, `第 ${round} 轮路线走不通`);
    assert.equal(walked.node, to);
    assert.ok(close(walked.arrive, result.arrive));
    assert.ok(result.arrive >= departAt);
    assert.ok(close(result.seconds, result.arrive - departAt));
  }
  assert.ok(Date.now() - started < 20000, '两千多次查询不该跑这么久');
});
