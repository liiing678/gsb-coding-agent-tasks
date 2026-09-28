import { compress, decompress, checksum, DEFAULTS } from '../lib/lzpack.js';

const text = 'the quick brown fox jumps over the lazy dog. the quick brown fox jumps over the lazy dog.';
const bytes = new TextEncoder().encode(text);
const packed = compress(bytes);
const back = decompress(packed);

const hex = (list) => [...list].map((one) => one.toString(16).padStart(2, '0')).join(' ');
const tiny = Uint8Array.from([0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x42]);

console.log('lzpack demo');
console.log(`  defaults: window=${DEFAULTS.window} minMatch=${DEFAULTS.minMatch} maxMatch=${DEFAULTS.maxMatch}`);
console.log(`  text ${bytes.length} -> ${packed.length} 字节`);
console.log(`  头部 ${hex(packed.subarray(0, 12))}`);
console.log(`  载荷 ${hex(packed.subarray(12, 24))} ...`);
console.log(`  校验和 ${checksum(bytes).toString(16).padStart(8, '0')}`);
console.log(`  解压回来一致：${Buffer.from(back).equals(Buffer.from(bytes))}`);
console.log(`  小样本 ${tiny.length} -> ${compress(tiny).length} 字节：${hex(compress(tiny))}`);
