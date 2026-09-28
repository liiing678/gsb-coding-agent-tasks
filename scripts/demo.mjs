import { createCodec, WIRE_TYPES } from '../lib/wirecodec.js';

const hex = (bytes) => [...bytes].map((one) => one.toString(16).padStart(2, '0')).join(' ');
const text = (bytes) => new TextDecoder().decode(bytes);

const codec = createCodec({
  schema: [
    { id: 1, name: 'seq', type: 'uint32' },
    { id: 2, name: 'delta', type: 'int32' },
    { id: 3, name: 'label', type: 'string' },
    { id: 4, name: 'tally', type: 'bool', repeated: true },
    { id: 6, name: 'note', type: 'bytes', required: true },
  ],
});

const message = {
  seq: 150,
  delta: -2,
  label: 'hi',
  note: new Uint8Array([0x0a]),
};
const packed = codec.encode(message);
console.log('wirecodec demo');
console.log(`  wire types: varint=${WIRE_TYPES.VARINT} fixed64=${WIRE_TYPES.FIXED64} bytes=${WIRE_TYPES.BYTES} fixed32=${WIRE_TYPES.FIXED32}`);
console.log(`  encode ${hex(packed)}`);
const head = codec.decode(packed).value;
console.log(`  decode seq=${head.seq} delta=${head.delta} label=${JSON.stringify(head.label)} note=${hex(head.note)}`);

// 别人后来的版本加了字段 9（varint）和字段 8（fixed32），我们这边不认识，但得原样带着走。
const fromFuture = Uint8Array.from([...packed, 0x48, 0x96, 0x01, 0x45, 0x78, 0x56, 0x34, 0x12]);
const parsed = codec.decode(fromFuture);
console.log(`  unknown ${parsed.unknownFields.map((one) => `${one.id}/wire${one.wireType}`).join(' ')}`);
console.log(`  re-encode ${hex(codec.encode(parsed.value, { unknownFields: parsed.unknownFields }))}`);

// 别的手写工具可能把 0 编成两个字节，重编码要收回最短形式。
const sloppy = Uint8Array.from([0x08, 0x80, 0x00, 0x32, 0x01, 0x0a]);
const back = codec.decode(sloppy);
console.log(`  sloppy ${hex(sloppy)} -> seq=${back.value.seq} note=${hex(back.value.note)}`);
console.log(`  canonical ${hex(codec.encode(back.value))}`);
