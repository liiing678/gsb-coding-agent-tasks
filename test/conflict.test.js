import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeps } from '../lib/resolve.js';
import { createRegistry } from '../lib/registry.js';

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'SolveError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

const backtrackRegistry = () =>
  createRegistry({
    packages: {
      alpha: { versions: { '1.1.0': { deps: { core: '^9.0.0' } }, '1.0.0': { deps: { core: '^1.0.0' } } } },
      core: { versions: { '1.0.0': {} } },
    },
  });

test('最新版走不通就退一档，最后能解出来', () => {
  const out = resolveDeps({
    registry: backtrackRegistry(),
    root: { name: 'app', version: '0.0.0', deps: { alpha: '^1.0.0' } },
  });
  assert.deepEqual(out.packages, { alpha: '1.0.0', core: '1.0.0' });
  assert.equal(out.stats.backtracks, 1);
  assert.equal(out.stats.considered, 3);
});

test('怎么都解不出来，报 ERR_UNSATISFIED 并带上卡住的包', () => {
  const registry = createRegistry({
    packages: {
      alpha: { versions: { '1.0.0': { deps: { core: '^1.0.0' } } } },
      beta: { versions: { '2.0.0': { deps: { core: '^3.0.0' } } } },
      core: { versions: { '1.0.0': {}, '3.0.0': {} } },
    },
  });
  const err = expectError(
    () =>
      resolveDeps({
        registry,
        root: { name: 'app', version: '0.0.0', deps: { alpha: '^1.0.0', beta: '^2.0.0' } },
      }),
    'ERR_UNSATISFIED',
  );
  assert.equal(err.details.pkg, 'core');
  assert.deepEqual(err.details.versions, []);
  assert.deepEqual(err.details.chain, [
    { from: 'alpha@1.0.0', range: '^1.0.0' },
    { from: 'beta@2.0.0', range: '^3.0.0' },
  ]);
});

test('冲突链里 root 提的要求排在前面', () => {
  const registry = createRegistry({
    packages: {
      alpha: { versions: { '1.0.0': { deps: { beta: '^9.0.0' } } } },
      beta: { versions: { '1.0.0': {} } },
    },
  });
  const err = expectError(
    () =>
      resolveDeps({
        registry,
        root: { name: 'app', version: '0.0.0', deps: { alpha: '^1.0.0', beta: '^1.0.0' } },
      }),
    'ERR_UNSATISFIED',
  );
  assert.equal(err.details.pkg, 'beta');
  assert.deepEqual(err.details.chain, [
    { from: 'app@0.0.0', range: '^1.0.0' },
    { from: 'alpha@1.0.0', range: '^9.0.0' },
  ]);
});

test('回退次数超上限就停下，报 ERR_TOO_MANY_BACKTRACKS', () => {
  const err = expectError(
    () =>
      resolveDeps({
        registry: backtrackRegistry(),
        root: { name: 'app', version: '0.0.0', deps: { alpha: '^1.0.0' } },
        maxBacktracks: 0,
      }),
    'ERR_TOO_MANY_BACKTRACKS',
  );
  assert.equal(err.details.maxBacktracks, 0);
  assert.equal(err.details.backtracks, 1);
});

test('包里没这个东西，立刻报 ERR_UNKNOWN_PACKAGE', () => {
  const registry = createRegistry({ packages: { alpha: { versions: { '1.0.0': {} } } } });
  const err = expectError(
    () =>
      resolveDeps({
        registry,
        root: { name: 'app', version: '0.0.0', deps: { alpha: '^1.0.0', ghost: '^1.0.0' } },
      }),
    'ERR_UNKNOWN_PACKAGE',
  );
  assert.equal(err.details.pkg, 'ghost');
  assert.deepEqual(err.details.from, ['app@0.0.0']);
});

test('范围写坏了报 ERR_BAD_RANGE，说清是谁提的', () => {
  const registry = createRegistry({
    packages: { alpha: { versions: { '1.0.0': { deps: { beta: '~>1.0' } } } }, beta: { versions: { '1.0.0': {} } } },
  });
  const err = expectError(
    () =>
      resolveDeps({ registry, root: { name: 'app', version: '0.0.0', deps: { alpha: '^1.0.0' } } }),
    'ERR_BAD_RANGE',
  );
  assert.deepEqual(
    { pkg: err.details.pkg, range: err.details.range, from: err.details.from },
    { pkg: 'beta', range: '~>1.0', from: 'alpha@1.0.0' },
  );
  expectError(
    () =>
      resolveDeps({
        registry,
        root: { name: 'app', version: '0.0.0', deps: { alpha: '^1.0.0 ||' } },
      }),
    'ERR_BAD_RANGE',
  );
});

test('候选版本一个都不剩的时候，versions 是空的', () => {
  const registry = createRegistry({
    packages: { alpha: { versions: { '1.0.0': {} } }, beta: { versions: { '2.0.0': {} } } },
  });
  const err = expectError(
    () =>
      resolveDeps({
        registry,
        root: { name: 'app', version: '0.0.0', deps: { alpha: '^1.0.0', beta: '^9.0.0' } },
      }),
    'ERR_UNSATISFIED',
  );
  assert.equal(err.details.pkg, 'beta');
  assert.deepEqual(err.details.versions, []);
  assert.deepEqual(err.details.chain, [{ from: 'app@0.0.0', range: '^9.0.0' }]);
});
