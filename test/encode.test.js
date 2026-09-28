import test from 'node:test';
import assert from 'node:assert/strict';

import { createCodec, WIRE_TYPES } from '../lib/wirecodec.js';
import { code, err, hex } from './util.js';

const schema = [
  { id: 3, name: 'label', type: 'string' },
  { id: 1, name: 'seq', type: 'uint32' },
  { id: 2, name: 'delta', type: 'int32' },
];

test('字段按编号升序写，跟 schema 里的顺序和对象里的键序都无关', () => {
  assert.equal(WIRE_TYPES.VARINT, 0);
  assert.equal(WIRE_TYPES.BYTES, 2);
  const codec = createCodec({ schema });
  assert.equal(hex(codec.encode({ seq: 150 })), '08 96 01');
  assert.equal(hex(codec.encode({ label: 'hi', seq: 150 })), '08 96 01 1a 02 68 69');
  assert.deepEqual(codec.fields().map((one) => one.id), [3, 1, 2]);
});

test('int32 走 zigzag，正负边界都要对', () => {
  const codec = createCodec({ schema: [{ id: 2, name: 'delta', type: 'int32' }] });
  assert.equal(hex(codec.encode({ delta: 0 })), '10 00');
  assert.equal(hex(codec.encode({ delta: -1 })), '10 01');
  assert.equal(hex(codec.encode({ delta: 1 })), '10 02');
  assert.equal(hex(codec.encode({ delta: -2 })), '10 03');
  assert.equal(hex(codec.encode({ delta: 2147483647 })), '10 fe ff ff ff 0f');
  assert.equal(hex(codec.encode({ delta: -2147483648 })), '10 ff ff ff ff 0f');
  assert.equal(code(() => codec.encode({ delta: 4294967295 })), 'ERR_BAD_VALUE');
  assert.equal(hex(codec.encode({ delta: -2147483648 })), '10 ff ff ff ff 0f');
});

test('字符串、字节串和布尔值各按各的写法', () => {
  const codec = createCodec({
    schema: [
      { id: 3, name: 'label', type: 'string' },
      { id: 4, name: 'blob', type: 'bytes' },
      { id: 5, name: 'flag', type: 'bool' },
    ],
  });
  assert.equal(hex(codec.encode({ label: 'hi' })), '1a 02 68 69');
  assert.equal(hex(codec.encode({ label: '' })), '1a 00');
  assert.equal(hex(codec.encode({ blob: Uint8Array.from([0x0a, 0x0b]) })), '22 02 0a 0b');
  assert.equal(hex(codec.encode({ flag: true })), '28 01');
  assert.equal(hex(codec.encode({ flag: false })), '28 00');
  // 没给或者给了 null 的字段根本不写
  assert.equal(hex(codec.encode({ label: null, flag: undefined })), '');
});

test('repeated 字段按数组顺序一条一条写，空数组等于没给', () => {
  const codec = createCodec({ schema: [{ id: 6, name: 'tally', type: 'uint32', repeated: true }] });
  assert.equal(hex(codec.encode({ tally: [1, 2] })), '30 01 30 02');
  assert.equal(hex(codec.encode({ tally: [] })), '');
  assert.equal(hex(codec.encode({})), '');
});

test('不认识的字段原样带出去，还要跟已知字段一起按编号排', () => {
  const codec = createCodec({ schema: [{ id: 1, name: 'seq', type: 'uint32' }] });
  const unknownFields = [
    { id: 9, wireType: 0, raw: Uint8Array.from([0x48, 0x96, 0x01]) },
    { id: 4, wireType: 5, raw: Uint8Array.from([0x25, 0x78, 0x56, 0x34, 0x12]) },
  ];
  assert.equal(hex(codec.encode({ seq: 150 }, { unknownFields })),
    '08 96 01 25 78 56 34 12 48 96 01');
});

test('必填没给就报 ERR_MISSING_REQUIRED', () => {
  const codec = createCodec({
    schema: [
      { id: 1, name: 'seq', type: 'uint32' },
      { id: 6, name: 'note', type: 'bytes', required: true },
    ],
  });
  const missing = err(() => codec.encode({ seq: 1 }));
  assert.equal(missing.code, 'ERR_MISSING_REQUIRED');
  assert.equal(missing.details.name, 'note');
  assert.equal(missing.details.id, 6);
  assert.equal(hex(codec.encode({ note: Uint8Array.from([1]) })), '32 01 01');
});

test('值不对报 ERR_BAD_VALUE，入参和配置不对报它自己的码', () => {
  const codec = createCodec({
    schema: [
      { id: 1, name: 'seq', type: 'uint32' },
      { id: 2, name: 'delta', type: 'int32' },
      { id: 3, name: 'label', type: 'string' },
      { id: 4, name: 'blob', type: 'bytes' },
      { id: 5, name: 'flag', type: 'bool' },
      { id: 6, name: 'tally', type: 'uint32', repeated: true },
    ],
  });
  assert.equal(code(() => codec.encode({ seq: -1 })), 'ERR_BAD_VALUE');
  assert.equal(code(() => codec.encode({ seq: 0x1_0000_0000 })), 'ERR_BAD_VALUE');
  assert.equal(code(() => codec.encode({ seq: 1.5 })), 'ERR_BAD_VALUE');
  assert.equal(code(() => codec.encode({ delta: 0x8000_0000 })), 'ERR_BAD_VALUE');
  assert.equal(code(() => codec.encode({ label: 3 })), 'ERR_BAD_VALUE');
  assert.equal(code(() => codec.encode({ blob: [1, 2] })), 'ERR_BAD_VALUE');
  assert.equal(code(() => codec.encode({ flag: 'yes' })), 'ERR_BAD_VALUE');
  assert.equal(code(() => codec.encode({ tally: 1 })), 'ERR_BAD_VALUE');

  assert.equal(code(() => codec.encode(null)), 'ERR_BAD_ARGS');
  assert.equal(code(() => codec.encode([1])), 'ERR_BAD_ARGS');
  assert.equal(code(() => codec.encode('x')), 'ERR_BAD_ARGS');
  assert.equal(code(() => codec.encode({}, { unknownFields: {} })), 'ERR_BAD_ARGS');
  assert.equal(code(() => codec.encode({}, { unknownFields: [{ id: 9, raw: [1] }] })),
    'ERR_BAD_ARGS');
  assert.equal(code(() => createCodec(5)), 'ERR_BAD_ARGS');
});

test('schema 自己不合法是 ERR_BAD_SCHEMA', () => {
  assert.equal(code(() => createCodec({})), 'ERR_BAD_SCHEMA');
  assert.equal(code(() => createCodec({ schema: 'seq' })), 'ERR_BAD_SCHEMA');
  assert.equal(code(() => createCodec({ schema: [{ id: 1, name: 'a', type: 'uint32' },
    { id: 1, name: 'b', type: 'uint32' }] })), 'ERR_BAD_SCHEMA');
  assert.equal(code(() => createCodec({ schema: [{ id: 1, name: 'a', type: 'float' }] })),
    'ERR_BAD_SCHEMA');
  assert.equal(code(() => createCodec({ schema: [{ id: 0, name: 'a', type: 'uint32' }] })),
    'ERR_BAD_SCHEMA');
  assert.equal(code(() => createCodec({ schema: [{ id: 2 ** 29, name: 'a', type: 'uint32' }] })),
    'ERR_BAD_SCHEMA');
  assert.equal(code(() => createCodec({ schema: [{ id: 1, name: '', type: 'uint32' }] })),
    'ERR_BAD_SCHEMA');
  assert.equal(code(() => createCodec({
    schema: [{ id: 1, name: 'a', type: 'uint32', repeated: true, required: true }],
  })), 'ERR_BAD_SCHEMA');
});
