import test from 'node:test';
import assert from 'node:assert/strict';

import { createLog, leafHash, verifyConsistency, verifyInclusion } from '../lib/merkletree.js';
import { code, flip, logOf } from './util.js';

test('包含证明：改动任何一处都验不过', () => {
  const log = logOf(5);
  const proof = log.inclusionProof(2);
  const good = { leaf: log.leafAt(2), index: 2, size: 5, path: proof.path, root: log.root() };
  assert.equal(verifyInclusion(good), true);
  assert.equal(verifyInclusion({ ...good, leaf: leafHash('别的') }), false);
  assert.equal(verifyInclusion({ ...good, index: 3 }), false);
  assert.equal(verifyInclusion({ ...good, size: 4 }), false);
  assert.equal(verifyInclusion({ ...good, root: flip(log.root()) }), false);
  assert.equal(verifyInclusion({
    ...good, path: [flip(proof.path[0]), proof.path[1], proof.path[2]],
  }), false);
  assert.equal(verifyInclusion({ ...good, path: [proof.path[1], proof.path[0], proof.path[2]] }), false);
  assert.equal(verifyInclusion({ ...good, path: proof.path.slice(0, 2) }), false);
  assert.equal(verifyInclusion({ ...good, path: [...proof.path, proof.path[0]] }), false);
  assert.equal(verifyInclusion({ ...good, index: 5 }), false);
  assert.equal(verifyInclusion({ ...good, size: 0 }), false);
});

test('包含证明的参数检查', () => {
  const log = logOf(3);
  const ok = {
    leaf: log.leafAt(1), index: 1, size: 3, path: log.inclusionProof(1).path, root: log.root(),
  };
  assert.equal(code(() => verifyInclusion(null)), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => verifyInclusion(undefined)), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => verifyInclusion({ ...ok, leaf: 'xyz' })), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => verifyInclusion({ ...ok, path: 'nope' })), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => verifyInclusion({ ...ok, path: [1] })), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => verifyInclusion({ ...ok, index: -1 })), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => verifyInclusion({ ...ok, size: 1.5 })), 'ERR_BAD_ARGUMENT');
});

test('一致性证明：m <= n 的每一组都成立', () => {
  for (let n = 1; n <= 12; n += 1) {
    const log = logOf(n);
    const toRoot = log.root();
    for (let m = 0; m <= n; m += 1) {
      assert.equal(verifyConsistency({
        fromSize: m, fromRoot: logOf(m).root(), toSize: n, toRoot, path: log.consistencyProof(m),
      }), true, `m=${m} n=${n}`);
    }
  }
});

test('一致性证明：改一处就验不过', () => {
  const log = logOf(6);
  const short = logOf(4);
  const good = {
    fromSize: 4, fromRoot: short.root(), toSize: 6, toRoot: log.root(),
    path: log.consistencyProof(4),
  };
  assert.equal(verifyConsistency(good), true);
  assert.equal(verifyConsistency({ ...good, fromRoot: flip(short.root()) }), false);
  assert.equal(verifyConsistency({ ...good, toRoot: flip(log.root()) }), false);
  assert.equal(verifyConsistency({ ...good, path: [flip(good.path[0]), ...good.path.slice(1)] }), false);
  assert.equal(verifyConsistency({ ...good, path: good.path.slice(1) }), false);
  assert.equal(verifyConsistency({ ...good, path: [...good.path, good.path[0]] }), false);
  assert.equal(verifyConsistency({ ...good, fromSize: 5 }), false);
  assert.equal(verifyConsistency({ ...good, fromSize: 7 }), false);
});

test('m = n 与 m = 0 的口径', () => {
  const log = logOf(4);
  const empty = createLog().root();
  assert.equal(verifyConsistency({
    fromSize: 4, fromRoot: log.root(), toSize: 4, toRoot: log.root(), path: [],
  }), true);
  assert.equal(verifyConsistency({
    fromSize: 4, fromRoot: log.root(), toSize: 4, toRoot: log.root(), path: [log.leafAt(0)],
  }), false);
  assert.equal(verifyConsistency({
    fromSize: 4, fromRoot: log.root(), toSize: 5, toRoot: log.root(), path: [],
  }), false);
  assert.equal(verifyConsistency({
    fromSize: 0, fromRoot: empty, toSize: 4, toRoot: log.root(), path: [],
  }), true);
  assert.equal(verifyConsistency({
    fromSize: 0, fromRoot: flip(empty), toSize: 4, toRoot: log.root(), path: [],
  }), false);
  assert.equal(verifyConsistency({
    fromSize: 0, fromRoot: empty, toSize: 4, toRoot: log.root(), path: [log.leafAt(0)],
  }), false);
});

test('一致性证明的参数检查', () => {
  const log = logOf(3);
  const ok = {
    fromSize: 1, fromRoot: logOf(1).root(), toSize: 3, toRoot: log.root(),
    path: log.consistencyProof(1),
  };
  assert.equal(code(() => verifyConsistency(null)), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => verifyConsistency(undefined)), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => verifyConsistency({ ...ok, fromRoot: 5 })), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => verifyConsistency({ ...ok, toSize: -1 })), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => verifyConsistency({ ...ok, path: {} })), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => verifyConsistency({ ...ok, path: ['zz'] })), 'ERR_BAD_ARGUMENT');
  assert.equal(verifyConsistency({ ...ok, fromSize: 4, toSize: 3, path: [] }), false);
});

test('大一点的日志抽查', () => {
  const log = logOf(100);
  const root = log.root();
  for (const index of [0, 1, 37, 63, 64, 99]) {
    const proof = log.inclusionProof(index);
    assert.equal(verifyInclusion({
      leaf: log.leafAt(index), index, size: 100, path: proof.path, root,
    }), true, `index=${index}`);
  }
  for (const m of [1, 2, 63, 64, 97]) {
    assert.equal(verifyConsistency({
      fromSize: m, fromRoot: logOf(m).root(), toSize: 100, toRoot: root,
      path: log.consistencyProof(m),
    }), true, `m=${m}`);
  }
});
