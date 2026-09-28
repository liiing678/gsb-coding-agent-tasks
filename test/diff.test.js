import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, diff, equals, invert, mergePatch } from '../lib/jsonpatch.js';

test('对象的 diff：删的在前，加的按 b 的键顺序，键序不算差异', () => {
  assert.deepEqual(diff({ a: 1, b: 2 }, { b: 2, a: 1 }), []);
  assert.deepEqual(diff({ a: 1, b: 2 }, { b: 3, c: 4 }), [
    { op: 'remove', path: '/a' },
    { op: 'replace', path: '/b', value: 3 },
    { op: 'add', path: '/c', value: 4 },
  ]);
  assert.deepEqual(diff({ a: { b: 1 } }, { a: { b: 2 } }),
    [{ op: 'replace', path: '/a/b', value: 2 }]);
  assert.deepEqual(diff([1, 2], { 0: 1 }), [{ op: 'replace', path: '', value: { 0: 1 } }]);
  assert.deepEqual(diff(7, 7), []);
});

test('数组的 diff 走 LCS：删的从后往前，加的从前往后', () => {
  assert.deepEqual(diff([1, 2, 3], [1, 3]), [{ op: 'remove', path: '/1' }]);
  assert.deepEqual(diff([1, 2, 3], [1, 3, 4]), [
    { op: 'remove', path: '/1' },
    { op: 'add', path: '/2', value: 4 },
  ]);
  assert.deepEqual(diff([1, 2, 3], [0, 1, 2, 3]), [{ op: 'add', path: '/0', value: 0 }]);
  assert.deepEqual(diff(['a', 'b', 'c', 'd'], ['b', 'd']), [
    { op: 'remove', path: '/2' },
    { op: 'remove', path: '/0' },
  ]);
  // 并列的时候算放弃 a 这边，所以从前面那个删起
  assert.deepEqual(diff([1, 2], [2, 1]), [
    { op: 'remove', path: '/0' },
    { op: 'add', path: '/1', value: 1 },
  ]);
});

test('apply(a, diff(a, b)) 深等于 b，各种形状都过一遍', () => {
  const pairs = [
    [{ a: [1, { x: 2 }], b: 'x' }, { a: [{ x: 2 }, 1], b: 'y', c: null }],
    [[1, 2, 3, 4, 5], [5, 4, 3]],
    [{ list: [{ id: 1 }, { id: 2 }, { id: 3 }] }, { list: [{ id: 3 }, { id: 1 }] }],
    [[], [1]],
    [[1], []],
    [7, { a: 1 }],
    [{ a: 1 }, 7],
    [null, { a: 1 }],
    [{ deep: { deeper: { x: [1, 2, 3] } } }, { deep: { deeper: { x: [1, 3] }, more: true } }],
    [{ a: 1 }, { a: 1 }],
    [[{ k: 'v' }, { k: 'w' }], [{ k: 'v' }, { k: 'w' }, { k: 'x' }]],
  ];
  for (const [before, after] of pairs) {
    const patch = diff(before, after);
    assert.equal(equals(after, apply(before, patch)), true,
      `还原失败：${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    // 一份文档本身、改过的原文档都不能被动到
    assert.equal(equals(before, before), true);
  }
  const doc = { list: [1, 2, 3] };
  apply(doc, diff(doc, { list: [2, 1] }));
  assert.deepEqual(doc, { list: [1, 2, 3] });
});

test('mergePatch：null 删键、对象递归合并、数组整体换', () => {
  assert.deepEqual(mergePatch({ a: 1, b: 2 }, { b: null, c: 3 }), { a: 1, c: 3 });
  assert.deepEqual(mergePatch({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } }),
    { a: { x: 1, y: 3, z: 4 } });
  assert.deepEqual(mergePatch({ a: [1, 2, 3] }, { a: [9] }), { a: [9] });
  assert.deepEqual(mergePatch({ a: 1 }, [1, 2]), [1, 2]);
  assert.deepEqual(mergePatch({ a: 1 }, null), null);
  assert.deepEqual(mergePatch(5, { a: 1 }), { a: 1 });
  assert.deepEqual(mergePatch({ a: 1 }, { b: { c: null } }), { a: 1, b: {} });

  const target = { a: { x: 1 }, list: [1, 2] };
  mergePatch(target, { a: { x: 2 }, list: [3] });
  assert.deepEqual(target, { a: { x: 1 }, list: [1, 2] });
});

test('invert：加、删、改、挪、拷都能反过来', () => {
  const doc = { a: { b: [1, 2, 3] }, keep: true };
  const patch = [
    { op: 'add', path: '/a/b/1', value: 9 },
    { op: 'replace', path: '/keep', value: false },
    { op: 'remove', path: '/a/b/3' },
    { op: 'add', path: '/fresh', value: 'x' },
  ];
  const after = apply(doc, patch);
  assert.deepEqual(apply(after, invert(patch, doc)), doc);

  const doc2 = { list: ['a', 'b', 'c'], src: { deep: 1 } };
  const patch2 = [
    { op: 'move', from: '/list/0', path: '/list/2' },
    { op: 'copy', from: '/src', path: '/copy' },
    { op: 'test', path: '/src', value: { deep: 1 } },
  ];
  const after2 = apply(doc2, patch2);
  assert.deepEqual(apply(after2, invert(patch2, doc2)), doc2);
  // test 不产生反向操作
  assert.deepEqual(invert([{ op: 'test', path: '/src', value: { deep: 1 } }], doc2), []);
});

test('invert 里对象上的 add 压掉旧值时要写回去', () => {
  const doc = { a: 1 };
  assert.deepEqual(invert([{ op: 'add', path: '/a', value: 2 }], doc),
    [{ op: 'replace', path: '/a', value: 1 }]);
  assert.deepEqual(invert([{ op: 'add', path: '/b', value: 2 }], doc),
    [{ op: 'remove', path: '/b' }]);
  assert.deepEqual(invert([{ op: 'remove', path: '/a' }], doc),
    [{ op: 'add', path: '/a', value: 1 }]);
  assert.deepEqual(invert([{ op: 'replace', path: '/a', value: 5 }], doc),
    [{ op: 'replace', path: '/a', value: 1 }]);
  assert.deepEqual(invert([{ op: 'copy', from: '/a', path: '/a' }], doc),
    [{ op: 'replace', path: '/a', value: 1 }]);
});
