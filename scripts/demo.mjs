import { UploadRelay } from '../lib/relay.js';
import { sha256Hex } from '../lib/hash.js';

const bytes = (size, seed = 7) =>
  Buffer.from(Array.from({ length: size }, (_, i) => (seed + i * 37) & 0xff));
const short = (hash) => hash.slice(0, 12);

const body = bytes(26);
const fingerprint = sha256Hex(body);
const relay = new UploadRelay({ maxStoreBytes: 60, now: () => 1000 });
const seen = [];
relay.onEvent((ev) => seen.push(ev.type));

console.log('chunkrelay demo');
console.log('[1] 一块块乱序传，中间重传一次');
const s = relay.create({ name: 'report.pdf', size: 26, chunkSize: 10, fingerprint });
console.log(`    create ${s.id} size=${s.size} chunkSize=${s.chunkSize} chunkCount=${s.chunkCount}`);
for (const index of [2, 0, 0, 1]) {
  const part = body.subarray(index * 10, index === 2 ? 26 : (index + 1) * 10);
  const out = relay.putChunk(s.id, index, part, sha256Hex(part));
  console.log(`    put #${index} ${part.length}B -> deduped=${out.deduped}`);
}
console.log(`    status received=[${relay.status(s.id).received}] missing=[${relay.status(s.id).missing}]`);
console.log(`    complete -> ${relay.complete(s.id).length}B sha256=${short(fingerprint)}`);

console.log('[2] 同样内容的第二份文件，字节只存一份');
seen.length = 0;
const copy = relay.create({ name: 'report-copy.pdf', size: 26, chunkSize: 10, fingerprint });
for (let index = 0; index < 3; index++) {
  const part = body.subarray(index * 10, index === 2 ? 26 : (index + 1) * 10);
  relay.putChunk(copy.id, index, part, sha256Hex(part));
}
relay.complete(copy.id);
const stats = relay.stats();
console.log(`    events ${[...new Set(seen)].join(',')}`);
console.log(
  `    stats blobs=${stats.blobs} storedBytes=${stats.storedBytes} logicalBytes=${stats.logicalBytes} savedBytes=${stats.savedBytes}`,
);

console.log('[3] 存储只剩一点点额度，新内容直接被拒');
const big = bytes(40, 3);
const third = relay.create({ name: 'big.bin', size: 40, chunkSize: 40, fingerprint: sha256Hex(big) });
try {
  relay.putChunk(third.id, 0, big, sha256Hex(big));
} catch (err) {
  console.log(`    reject ${err.code}: 需要 ${err.details.needed}B，现在有 ${err.details.storedBytes}B`);
}

console.log('[4] 换一个进程接着传，再把过期的清掉');
const revived = new UploadRelay({
  store: relay.store,
  now: () => 2000,
  ttlMs: 1000,
  completedTtlMs: 500,
});
revived.restore(JSON.parse(JSON.stringify(relay.snapshot())));
console.log(`    restored sessions=${revived.stats().sessions} blobs=${revived.stats().blobs}`);
const swept = revived.sweep();
console.log(`    sweep expired=[${swept.expired}] released=${swept.released.length}`);
console.log(`    stats blobs=${revived.stats().blobs} storedBytes=${revived.stats().storedBytes}`);
