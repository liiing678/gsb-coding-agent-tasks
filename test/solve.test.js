import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeps } from '../lib/resolve.js';
import { createRegistry } from '../lib/registry.js';

test('依赖的依赖也一起解出来', () => {
  const registry = createRegistry({
    packages: {
      applib: { versions: { '1.0.0': { deps: { 'core-lib': '^1.0.0' } } } },
      'core-lib': { versions: { '1.4.0': { deps: {} } } },
    },
  });
  const out = resolveDeps({
    registry,
    root: { name: 'app', version: '0.0.0', deps: { applib: '^1.0.0' } },
  });
  assert.deepEqual(out.packages, { applib: '1.0.0', 'core-lib': '1.4.0' });
  assert.deepEqual(out.order, ['core-lib', 'applib']);
  assert.deepEqual(out.stats, { considered: 2, backtracks: 0, constraints: 2 });
});

test('多个约束一起看，选都满足的最高版本', () => {
  const registry = createRegistry({
    packages: {
      cache: { versions: { '1.0.0': {}, '1.1.0': {}, '1.2.0': {}, '2.0.0': {} } },
      alpha: { versions: { '1.0.0': { deps: { cache: '<1.2.0' } } } },
      beta: { versions: { '1.0.0': { deps: { cache: '^1.0.0' } } } },
    },
  });
  const out = resolveDeps({
    registry,
    root: { name: 'app', version: '0.0.0', deps: { alpha: '^1.0.0', beta: '^1.0.0' } },
  });
  assert.equal(out.packages.cache, '1.1.0');
  assert.deepEqual(out.order, ['cache', 'alpha', 'beta']);
});

test('版本号按数字比，1.10.0 比 1.9.0 高', () => {
  const registry = createRegistry({
    packages: { compress: { versions: { '1.9.0': {}, '1.10.0': {} } } },
  });
  const out = resolveDeps({
    registry,
    root: { name: 'app', version: '0.0.0', deps: { compress: '^1.9.0' } },
  });
  assert.equal(out.packages.compress, '1.10.0');
});

test('互相依赖成环也能解，不会转不出来', () => {
  const registry = createRegistry({
    packages: {
      alpha: { versions: { '1.0.0': { deps: { beta: '^1.0.0' } } } },
      beta: { versions: { '1.0.0': { deps: { alpha: '^1.0.0' } } } },
    },
  });
  const out = resolveDeps({
    registry,
    root: { name: 'app', version: '0.0.0', deps: { alpha: '^1.0.0' } },
  });
  assert.deepEqual(out.packages, { alpha: '1.0.0', beta: '1.0.0' });
  assert.deepEqual(out.order, ['alpha', 'beta']);
});

test('同一个包被好几处约束，条数照实数', () => {
  const registry = createRegistry({
    packages: {
      shared: { versions: { '1.0.0': {}, '1.5.0': {}, '2.0.0': {} } },
      alpha: { versions: { '1.0.0': { deps: { shared: '^1.0.0' } } } },
      beta: { versions: { '1.0.0': { deps: { shared: '1.5.0' } } } },
    },
  });
  const out = resolveDeps({
    registry,
    root: { name: 'app', version: '0.0.0', deps: { alpha: '^1.0.0', beta: '^1.0.0' } },
  });
  assert.equal(out.packages.shared, '1.5.0');
  assert.equal(out.stats.constraints, 4);
});

test('只有一个版本进了候选就只考虑那一个', () => {
  const registry = createRegistry({
    packages: { logger: { versions: { '0.9.0': {}, '1.0.0': {}, '1.1.0': {}, '2.0.0': {} } } },
  });
  const out = resolveDeps({
    registry,
    root: { name: 'app', version: '0.0.0', deps: { logger: '^1.0.0' } },
  });
  assert.equal(out.packages.logger, '1.1.0');
  assert.equal(out.stats.considered, 1);
});

test('包源里键的写法不影响结果', () => {
  const build = (order) =>
    createRegistry({ packages: Object.fromEntries(order.map(([name, versions]) => [name, { versions }])) });
  const left = resolveDeps({
    registry: build([
      ['alpha', { '1.0.0': { deps: { omega: '^1.0.0', beta: '^1.0.0' } } }],
      ['beta', { '1.2.0': {} }],
      ['omega', { '1.1.0': {} }],
    ]),
    root: { name: 'app', version: '0.0.0', deps: { alpha: '^1.0.0' } },
  });
  const right = resolveDeps({
    registry: build([
      ['omega', { '1.1.0': {} }],
      ['beta', { '1.2.0': {} }],
      ['alpha', { '1.0.0': { deps: { beta: '^1.0.0', omega: '^1.0.0' } } }],
    ]),
    root: { name: 'app', version: '0.0.0', deps: { alpha: '^1.0.0' } },
  });
  assert.deepEqual(left, right);
  assert.deepEqual(left.order, ['beta', 'omega', 'alpha']);
});

test('root 写错了直接报 ERR_BAD_INPUT', () => {
  const registry = createRegistry({ packages: { alpha: { versions: { '1.0.0': {} } } } });
  for (const root of [
    { name: 'app', deps: [] },
    { name: '', deps: {} },
    { name: 'app', version: 'one', deps: {} },
  ]) {
    assert.throws(
      () => resolveDeps({ registry, root }),
      (err) => err.name === 'SolveError' && err.code === 'ERR_BAD_INPUT',
    );
  }
});
