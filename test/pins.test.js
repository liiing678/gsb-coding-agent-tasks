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

const registry = () =>
  createRegistry({
    packages: {
      alpha: { versions: { '1.0.0': {} } },
      core: { versions: { '1.0.0': {}, '1.1.0': {}, '2.0.0': {} } },
    },
  });

test('钉住的版本就是它，哪怕有更高的', () => {
  const out = resolveDeps({
    registry: registry(),
    root: { name: 'app', version: '0.0.0', deps: { alpha: '^1.0.0', core: '^1.0.0' } },
    pins: { core: '1.0.0' },
  });
  assert.equal(out.packages.core, '1.0.0');
  assert.equal(out.stats.considered, 2);
});

test('钉住的版本跟约束打架，报 ERR_PIN_CONFLICT', () => {
  const err = expectError(
    () =>
      resolveDeps({
        registry: registry(),
        root: { name: 'app', version: '0.0.0', deps: { core: '^2.0.0' } },
        pins: { core: '1.0.0' },
      }),
    'ERR_PIN_CONFLICT',
  );
  assert.deepEqual(
    { pkg: err.details.pkg, pin: err.details.pin, range: err.details.range, from: err.details.from },
    { pkg: 'core', pin: '1.0.0', range: '^2.0.0', from: 'app@0.0.0' },
  );
});

test('钉到一个包源里没有的版本，报 ERR_NO_SUCH_VERSION', () => {
  const err = expectError(
    () =>
      resolveDeps({
        registry: registry(),
        root: { name: 'app', version: '0.0.0', deps: { core: '^1.0.0' } },
        pins: { core: '3.0.0' },
      }),
    'ERR_NO_SUCH_VERSION',
  );
  assert.deepEqual(err.details.versions, ['2.0.0', '1.1.0', '1.0.0']);
});

test('没人依赖的钉住包不进结果，也不报错', () => {
  const out = resolveDeps({
    registry: registry(),
    root: { name: 'app', version: '0.0.0', deps: { alpha: '^1.0.0' } },
    pins: { 'not-in-registry': '1.0.0' },
  });
  assert.deepEqual(out.packages, { alpha: '1.0.0' });
});

test('pins 的值不是 x.y.z 报 ERR_BAD_INPUT', () => {
  const err = expectError(
    () =>
      resolveDeps({
        registry: registry(),
        root: { name: 'app', version: '0.0.0', deps: { alpha: '^1.0.0' } },
        pins: { alpha: '1.0.x' },
      }),
    'ERR_BAD_INPUT',
  );
  assert.equal(err.details.field, 'pins');
  assert.equal(err.details.pkg, 'alpha');
});

test('依赖的范围不是字符串也报 ERR_BAD_INPUT', () => {
  const err = expectError(
    () =>
      resolveDeps({
        registry: registry(),
        root: { name: 'app', version: '0.0.0', deps: { alpha: 1 } },
      }),
    'ERR_BAD_INPUT',
  );
  assert.equal(err.details.field, 'deps');
  assert.equal(err.details.pkg, 'alpha');
});
