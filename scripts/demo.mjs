import { decodeSeries, encodeSeries, stats } from '../lib/tscodec.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const line = (label, value) => console.log(`  ${label} ${value}`);
const code = (fn) => {
  try {
    fn();
    return 'ok';
  } catch (err) {
    return err.code;
  }
};

console.log('tscodec demo');

const points = [
  { t: 1700000000000, v: 23.5 },
  { t: 1700000001000, v: 23.5 },
  { t: 1700000002000, v: 24.25 },
  { t: 1700000003000, v: 24.25 },
  { t: 1700000005000, v: 23 },
  { t: 1700000006000, v: 23 },
];

const bytes = encodeSeries(points);
line('bytes', String(bytes.length));
line('header', hex(bytes.slice(0, 11)));
line('stats', JSON.stringify(stats(bytes)));

const decoded = decodeSeries(bytes);
line('points', String(decoded.points.length));
line('blocks', String(decoded.blocks));
line('first', JSON.stringify(decoded.points[0]));
line('last', JSON.stringify(decoded.points.at(-1)));
line('reencode', String(hex(encodeSeries(decoded.points)) === hex(bytes)));

const broken = Uint8Array.from(bytes);
broken[28] ^= 0x01;
line('corrupted', code(() => decodeSeries(broken)));

const constant = Array.from({ length: 100 }, (_, i) => ({ t: i * 1000, v: 3 }));
const constantBytes = encodeSeries(constant);
line('constantBytes', String(constantBytes.length));
line('constantStats', JSON.stringify(stats(constantBytes)));
line('constantDecoded', String(decodeSeries(constantBytes).points.length));
