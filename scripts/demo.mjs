import { createReplica } from '../lib/replica.js';

const c1 = createReplica({ clientId: 'c1' });
const c2 = createReplica({ clientId: 'c2' });

console.log('seqmerge demo');

console.log('[1] 一个人敲字');
const seed = c1.insert(0, 'hello');
console.log(`    ${c1.clientId} text=${c1.text} op=${seed.id} chars=${seed.chars.map((one) => one.ch).join('')}`);

console.log('[2] 把 op 投给另一个副本');
c2.receive(seed);
console.log(`    ${c2.clientId} text=${c2.text}`);

console.log('[3] 并发：c1 在最前面插 X，c2 把 hello 删掉');
const inserted = c1.insert(0, 'X');
const removed = c2.delete(0, 5);
c2.receive(inserted);
console.log(`    ${c2.clientId} 先收到插入 text=${c2.text}`);

console.log('[4] 另一条路收到删除，两边一样');
c1.receive(removed);
console.log(`    ${c1.clientId} text=${c1.text} ${c2.clientId} text=${c2.text}`);

console.log('[5] 乱序到达：先收到 seq=2，只能先压着');
const late = createReplica({ clientId: 'c3' });
const accepted = late.receive(inserted);
console.log(`    ${late.clientId} 先收 ${inserted.id} -> ${accepted} buffered=${late.stats().buffered}`);
late.receive(seed);
console.log(`    补齐 ${seed.id} 之后 text=${late.text} buffered=${late.stats().buffered}`);

console.log('[6] 同一个 op 再投一次不会生效两次');
const again = c2.receive(inserted);
console.log(`    ${c2.clientId} 再收一次 -> ${again} duplicates=${c2.stats().duplicates} text=${c2.text}`);

console.log('[7] 统计');
console.log(`    ${JSON.stringify(c1.stats())}`);
