import test from 'node:test';
import assert from 'node:assert/strict';

import { createCodec } from '../lib/wirecodec.js';
import { code, err, fromHex, hex } from './util.js';

const codec = createCodec({
  schema: [
    { id: 1, name: 'seq', type: 'uint32' },
    { id: 2, name: 'label', type: 'string' },
    { id: 3, name: 'delta', type: 'int32', repeated: true },
    { id: 6, name: 'note', type: 'bytes' },
  ],
});

test('按编号找字段，没出现的字段就不在结果里', () => {
  assert.deepEqual(codec.decode(fromHex('08 96 01 12 02 68 69')).value,
    { seq: 150, label: 'hi' });
  assert.deepEqual(codec.decode(fromHex('')).value, {});
});

test('repeated 收成数组，不 repeated 的后来者覆盖', () => {
  assert.deepEqual(codec.decode(fromHex('18 01 18 04')).value, { delta: [-1, 2] });
  assert.deepEqual(codec.decode(fromHex('08 01 08 02')).value, { seq: 2 });
});

test('不认识的字段原样留着，重编码字节一模一样', () => {
  const input = fromHex('08 96 01 32 01 0a 45 78 56 34 12 48 96 01');
  const one = { id: 8, wireType: 5, raw: fromHex('45 78 56 34 12') };
  const two = { id: 9, wireType: 0, raw: fromHex('48 96 01') };

  const back = codec.decode(input);
  assert.deepEqual(back.value, { seq: 150, note: Uint8Array.from([0x0a]) });
  assert.deepEqual(back.unknownFields, [one, two]);
  assert.equal(hex(codec.encode(back.value, { unknownFields: back.unknownFields })),
    hex(input));
  // 拿到手的 raw 是新的一份，改它不影响原来那条
  back.unknownFields[0].raw[1] = 0;
  assert.equal(hex(back.unknownFields[0].raw), '45 00 56 34 12');
});

test('不是最短形式的变长整数能解开，但重编码要收回最短', () => {
  const sloppy = fromHex('08 80 00 18 80 80 80 80 00');
  const back = codec.decode(sloppy);
  assert.deepEqual(back.value, { seq: 0, delta: [0] });
  assert.equal(hex(codec.encode(back.value)), '08 00 18 00');
});

test('读一半没了是 ERR_TRUNCATED', () => {
  assert.equal(code(() => codec.decode(fromHex('08 96'))), 'ERR_TRUNCATED');
  assert.equal(code(() => codec.decode(fromHex('12 05 68 69'))), 'ERR_TRUNCATED');
  assert.equal(code(() => codec.decode(fromHex('45 78 56'))), 'ERR_TRUNCATED');
  assert.equal(code(() => codec.decode(fromHex('49 01 02 03'))), 'ERR_TRUNCATED');
});

test('变长整数超长是 ERR_VARINT_OVERFLOW', () => {
  assert.equal(code(() => codec.decode(fromHex('08 ff ff ff ff 7f'))), 'ERR_VARINT_OVERFLOW');
  assert.equal(code(() => codec.decode(fromHex('08 80 80 80 80 80 00'))), 'ERR_VARINT_OVERFLOW');
  assert.equal(hex(codec.encode({ seq: 0xffffffff })), '08 ff ff ff ff 0f');
  assert.deepEqual(codec.decode(fromHex('08 ff ff ff ff 0f')).value, { seq: 0xffffffff });
});

test('字段号和 wire type 不认就是 ERR_BAD_WIRE_TYPE', () => {
  assert.equal(code(() => codec.decode(fromHex('00 00'))), 'ERR_BAD_WIRE_TYPE');
  assert.equal(code(() => codec.decode(fromHex('0b 00'))), 'ERR_BAD_WIRE_TYPE');
  // 字段 1 是 uint32，来的却是 length-delimited
  assert.equal(code(() => codec.decode(fromHex('0a 01 68'))), 'ERR_BAD_WIRE_TYPE');
});

test('布尔只认 0 和 1，字符串必须是合法 UTF-8', () => {
  const bool = createCodec({ schema: [{ id: 5, name: 'flag', type: 'bool' }] });
  assert.deepEqual(bool.decode(fromHex('28 01')).value, { flag: true });
  assert.equal(code(() => bool.decode(fromHex('28 02'))), 'ERR_BAD_VALUE');

  const failure = err(() => codec.decode(fromHex('12 02 ff fe')));
  assert.equal(failure.code, 'ERR_BAD_UTF8');
  assert.equal(failure.details.name, 'label');
});

test('必填字段在下游没解出来也要报', () => {
  const strict = createCodec({
    schema: [
      { id: 1, name: 'seq', type: 'uint32', required: true },
      { id: 2, name: 'label', type: 'string' },
    ],
  });
  assert.equal(code(() => strict.decode(fromHex('12 01 68'))), 'ERR_MISSING_REQUIRED');
  assert.deepEqual(strict.decode(fromHex('08 01 12 01 68')).value, { seq: 1, label: 'h' });
  assert.equal(code(() => strict.decode('08 01')), 'ERR_BAD_ARGS');
});
