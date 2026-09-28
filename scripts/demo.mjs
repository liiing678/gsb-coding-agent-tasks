import zlib from 'node:zlib';

import { adler32, inflateRaw, inflateZlib } from '../lib/flate.js';

const line = (label, value) => console.log(`  ${label} ${value}`);

const data = Buffer.from('flate demo '.repeat(12), 'utf8');

console.log('flate demo');
const stored = zlib.deflateRawSync(data, { level: 0 });
line('stored.bytes', stored.length);
line('stored.ok', String(Buffer.from(inflateRaw(stored)).equals(data)));

const fixed = zlib.deflateRawSync(data, { strategy: zlib.constants.Z_FIXED });
line('fixed.bytes', fixed.length);
line('fixed.ok', String(Buffer.from(inflateRaw(fixed)).equals(data)));

const dynamic = zlib.deflateRawSync(data, { level: 9 });
line('dynamic.bytes', dynamic.length);
line('dynamic.ok', String(Buffer.from(inflateRaw(dynamic)).equals(data)));

const wrapped = zlib.deflateSync(data, { level: 9 });
line('zlib.bytes', wrapped.length);
line('zlib.text', Buffer.from(inflateZlib(wrapped)).toString('utf8').slice(0, 23));
line('adler32.empty', adler32(new Uint8Array(0)));
line('adler32.Wikipedia', adler32(Buffer.from('Wikipedia', 'utf8')));

const corrupted = Buffer.from(wrapped);
corrupted[corrupted.length - 1] ^= 0xff;
try {
  inflateZlib(corrupted);
} catch (err) {
  line('corrupted.code', err.code);
}

const cut = dynamic.subarray(0, Math.floor(dynamic.length / 2));
try {
  inflateRaw(cut);
} catch (err) {
  line('truncated.code', err.code);
}