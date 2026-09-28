import {
  apply, diff, equals, formatPointer, get, invert, mergePatch, parsePointer,
} from '../lib/jsonpatch.js';

const capture = (fn) => {
  try {
    fn();
    return 'no error';
  } catch (err) {
    return `${err.code}@${err.details.index ?? '-'}`;
  }
};

const line = (label, value) => console.log(`  ${label} ${value}`);

const doc = { name: 'demo', tags: ['a', 'b', 'c'], meta: { keep: true, drop: 1 } };
const target = { name: 'demo', tags: ['a', 'c', 'd'], meta: { keep: false }, extra: 7 };

console.log('jsonpatch demo');
line('pointer', formatPointer(parsePointer('/tags/1')));
line('get', JSON.stringify(get(doc, '/tags/1')));

const patch = diff(doc, target);
line('diff', JSON.stringify(patch));
const after = apply(doc, patch);
line('applied', JSON.stringify(after));
line('roundtrip', String(equals(after, target)));
line('inverted', String(equals(apply(after, invert(patch, doc)), doc)));
line('untouched', JSON.stringify(doc));

line('merge', JSON.stringify(mergePatch({ a: { x: 1 }, drop: 1 }, { a: { y: 2 }, drop: null })));
line('mergeArray', JSON.stringify(mergePatch({ list: [1, 2] }, { list: [3] })));
line('badTest', capture(() => apply(doc, [{ op: 'add', path: '/x', value: 1 },
  { op: 'test', path: '/x', value: 2 }])));
line('badPointer', capture(() => apply(doc, [{ op: 'remove', path: 'tags' }])));
line('missing', capture(() => apply(doc, [{ op: 'remove', path: '/nope' }])));
