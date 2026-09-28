import test from 'node:test';
import assert from 'node:assert/strict';

import { createLog, leafHash, nodeHash, verifyInclusion } from '../lib/merkletree.js';
import { code, logOf } from './util.js';

const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const LEAF = [
  '305df59f9590c3c9ac63d2b2743c388e3792449078cebf7fb3dbe6471643b2b7',
  '3145c409f259b7c53e32036090ff76751025a2498ba9823ef718cac50b4e616f',
  'fca89f57c9f8c8eb4047a7ff9d333acf9e0f3384b20b255bceab0f216dcca267',
  'f76836325aec5699d8d71f8e42e9d47c5c29b08059ba296384f7ca40ad3a40ae',
  'ea9fc1a1b6e191b460d0d6306e3e870c173f39330f13cda1b70cfc72bdc398ba',
];
const ROOT = [
  LEAF[0],
  '60a53eed0de87a90c8e59427c59c46253c33a76a09502a51801300927b7e6bdc',
  'cf763a041c81ceef1578a6083f75c61bef2e0014f2a3e683a97fcfca5be7f19a',
  'bdd1c5ff55b19cb6b0e7c761bf9a6ccaa27fbbfc07b74f1fabb6e911a0bd2ab3',
  '00d21829a5503145348abcf712513eacf2a274211ad83e970202bb5b6d80b286',
];

test('叶子与节点的哈希构造', () => {
  for (let i = 0; i < LEAF.length; i += 1) {
    assert.equal(leafHash(`leaf-${i}`), LEAF[i]);
  }
  assert.equal(nodeHash(LEAF[0], LEAF[1]), ROOT[1]);
  assert.equal(nodeHash(ROOT[1], nodeHash(LEAF[2], LEAF[3])), ROOT[3]);
  assert.notEqual(leafHash('leaf-0'), leafHash('leaf-1'));
  assert.equal(code(() => leafHash(5)), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => nodeHash(LEAF[0], 'zz')), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => nodeHash(LEAF[0].toUpperCase(), LEAF[1])), 'ERR_BAD_ARGUMENT');
});

test('append / appendAll / size / leafAt / root', () => {
  const log = createLog();
  assert.equal(log.size(), 0);
  assert.equal(log.root(), EMPTY);
  for (let i = 0; i < LEAF.length; i += 1) {
    assert.deepEqual(log.append(`leaf-${i}`), { index: i, hash: LEAF[i] });
    assert.equal(log.size(), i + 1);
    assert.equal(log.root(), ROOT[i]);
    assert.equal(log.leafAt(i), LEAF[i]);
  }
  assert.deepEqual(createLog().appendAll(['leaf-0', 'leaf-1']).map((entry) => entry.index), [0, 1]);
  assert.equal(logOf(4).size(), 4);
  assert.equal(code(() => log.append(7)), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => log.appendAll('abc')), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => log.leafAt(5)), 'ERR_OUT_OF_RANGE');
  assert.equal(code(() => log.leafAt(-1)), 'ERR_BAD_ARGUMENT');
});

test('包含证明的形状与内容', () => {
  const log = logOf(5);
  assert.deepEqual(log.inclusionProof(2), { index: 2, size: 5, path: [LEAF[3], ROOT[1], LEAF[4]] });
  assert.deepEqual(log.inclusionProof(4), { index: 4, size: 5, path: [ROOT[3]] });
  assert.deepEqual(log.inclusionProof(0), {
    index: 0, size: 5, path: [LEAF[1], nodeHash(LEAF[2], LEAF[3]), LEAF[4]],
  });
  assert.equal(code(() => log.inclusionProof(5)), 'ERR_OUT_OF_RANGE');
  assert.equal(code(() => log.inclusionProof(1.5)), 'ERR_BAD_ARGUMENT');
});

test('每一棵子树的每个下标都能验过自己的包含证明', () => {
  for (let size = 1; size <= 12; size += 1) {
    const log = logOf(size);
    for (let index = 0; index < size; index += 1) {
      const proof = log.inclusionProof(index);
      assert.equal(verifyInclusion({
        leaf: log.leafAt(index), index, size, path: proof.path, root: log.root(),
      }), true, `size=${size} index=${index}`);
    }
  }
});

test('一致性证明的形状与内容', () => {
  const log = logOf(5);
  assert.deepEqual(log.consistencyProof(0), []);
  assert.deepEqual(log.consistencyProof(5), []);
  assert.deepEqual(log.consistencyProof(1), [LEAF[1], nodeHash(LEAF[2], LEAF[3]), LEAF[4]]);
  assert.deepEqual(log.consistencyProof(2), [nodeHash(LEAF[2], LEAF[3]), LEAF[4]]);
  assert.deepEqual(log.consistencyProof(3), [LEAF[2], LEAF[3], ROOT[1], LEAF[4]]);
  assert.deepEqual(log.consistencyProof(4), [LEAF[4]]);
  assert.equal(code(() => log.consistencyProof(6)), 'ERR_OUT_OF_RANGE');
  assert.equal(code(() => log.consistencyProof(-1)), 'ERR_BAD_ARGUMENT');
});

test('日志自己的参数错误', () => {
  const log = logOf(3);
  assert.equal(code(() => log.append()), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => log.appendAll([1, 2])), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => log.leafAt('0')), 'ERR_BAD_ARGUMENT');
  assert.equal(code(() => log.inclusionProof(2.5)), 'ERR_BAD_ARGUMENT');
});
