import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/jsonpatch.js';
import { code, grab } from './util.js';

test('add / remove / replace 在对象和数组上的规矩', () => {
  const doc = { list: [1, 3], obj: { a: 1 } };
  const added = apply(doc, [
    { op: 'add', path: '/list/1', value: 2 },
    { op: 'add', path: '/list/-', value: 4 },
    { op: 'add', path: '/obj/b', value: 2 },
    { op: 'replace', path: '/obj/a', value: 9 },
    { op: 'remove', path: '/list/0' },
  ]);
  assert.deepEqual(added, { list: [2, 3, 4], obj: { a: 9, b: 2 } });
  assert.deepEqual(doc, { list: [1, 3], obj: { a: 1 } });

  // 覆盖已有的键，位置不动；新键追在最后
  const overwritten = apply({ a: 1, b: 2 }, [
    { op: 'add', path: '/a', value: 9 },
    { op: 'add', path: '/c', value: 3 },
  ]);
  assert.deepEqual(Object.keys(overwritten), ['a', 'b', 'c']);
  assert.deepEqual(overwritten, { a: 9, b: 2, c: 3 });

  // 空指针就是整份文档
  assert.deepEqual(apply({ a: 1 }, [{ op: 'add', path: '', value: { b: 2 } }]), { b: 2 });
  assert.deepEqual(apply({ a: 1 }, [{ op: 'replace', path: '', value: 7 }]), 7);
});

test('下标越界、move、copy、test', () => {
  const doc = { list: [1, 2, 3] };
  assert.deepEqual(apply(doc, [{ op: 'add', path: '/list/3', value: 4 }]), { list: [1, 2, 3, 4] });
  assert.equal(code(() => apply(doc, [{ op: 'add', path: '/list/4', value: 4 }])),
    'ERR_PATH_MISSING');
  assert.equal(code(() => apply(doc, [{ op: 'remove', path: '/list/3' }])), 'ERR_PATH_MISSING');
  assert.equal(code(() => apply(doc, [{ op: 'replace', path: '/list/3', value: 4 }])),
    'ERR_PATH_MISSING');
  assert.equal(code(() => apply(doc, [{ op: 'remove', path: '/list/-' }])), 'ERR_PATH_MISSING');

  assert.deepEqual(apply(doc, [{ op: 'move', from: '/list/0', path: '/list/2' }]),
    { list: [2, 3, 1] });
  assert.equal(code(() => apply(doc, [{ op: 'move', from: '/list/9', path: '/list/0' }])),
    'ERR_PATH_MISSING');

  const copied = apply({ src: { deep: 1 } }, [{ op: 'copy', from: '/src', path: '/dst' }]);
  assert.deepEqual(copied, { src: { deep: 1 }, dst: { deep: 1 } });
  copied.dst.deep = 2;
  assert.equal(copied.src.deep, 1);

  assert.deepEqual(apply(doc, [{ op: 'test', path: '/list/0', value: 1 }]), doc);
  assert.deepEqual(apply({ o: { a: 1, b: 2 } }, [
    { op: 'test', path: '/o', value: { b: 2, a: 1 } },
  ]), { o: { a: 1, b: 2 } });
  assert.equal(code(() => apply(doc, [{ op: 'test', path: '/list/0', value: 2 }])),
    'ERR_TEST_FAILED');
  assert.equal(code(() => apply(doc, [{ op: 'test', path: '/list/9', value: 1 }])),
    'ERR_PATH_MISSING');
});

test('patch 是原子的，出错的时候原文档不动', () => {
  const doc = { list: [1, 2, 3] };
  assert.equal(code(() => apply(doc, [
    { op: 'add', path: '/ok', value: 1 },
    { op: 'remove', path: '/nope' },
  ])), 'ERR_PATH_MISSING');
  assert.deepEqual(doc, { list: [1, 2, 3] });

  const err = grab(() => apply(doc, [
    { op: 'test', path: '/list/0', value: 1 },
    { op: 'test', path: '/list/0', value: 2 },
  ]));
  assert.equal(err.code, 'ERR_TEST_FAILED');
  assert.equal(err.details.index, 1);
});

test('不认识的 op、缺字段、坏指针各有各的码', () => {
  const doc = { a: 1 };
  assert.equal(code(() => apply(doc, 'nope')), 'ERR_BAD_PATCH');
  assert.equal(code(() => apply(doc, [{ op: 'nope', path: '/a' }])), 'ERR_BAD_PATCH');
  assert.equal(code(() => apply(doc, [{ op: 'add', path: '/b' }])), 'ERR_BAD_PATCH');
  assert.equal(code(() => apply(doc, [{ op: 'replace', path: '/a' }])), 'ERR_BAD_PATCH');
  assert.equal(code(() => apply(doc, [{ op: 'move', path: '/b' }])), 'ERR_BAD_PATCH');
  assert.equal(code(() => apply(doc, [{ op: 'copy', from: '/a' }])), 'ERR_BAD_PATCH');
  assert.equal(code(() => apply(doc, [{ op: 'add', path: 'b', value: 1 }])), 'ERR_BAD_POINTER');
  assert.equal(code(() => apply(doc, [{ op: 'remove', path: '' }])), 'ERR_BAD_PATCH');
  assert.equal(code(() => apply(doc, [{ op: 'move', from: '/a', path: '/a/b' }])), 'ERR_BAD_PATCH');
  assert.equal(code(() => apply(doc, [{ op: 'copy', from: '/a', path: '' }])), 'ERR_BAD_PATCH');
  assert.equal(code(() => apply(doc, [{ op: 'move', from: '', path: '/a' }])), 'ERR_BAD_PATCH');
});
