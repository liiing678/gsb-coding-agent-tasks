import { createStore } from '../lib/store.js';
import { createMemoryLog } from '../lib/log.js';
import { decodeFrames } from '../lib/codec.js';

console.log('durakv demo');

const log = createMemoryLog();
const store = createStore({ log });

console.log('[1] 两个事务提交，一个事务写了一半就不管了');
const first = store.begin();
store.set(first, 'user:1', 'ann');
store.set(first, 'user:2', 'bo');
console.log(`    commit ${first.id} -> version ${store.commit(first).version}`);
const second = store.begin();
store.set(second, 'user:1', 'ann-w');
store.del(second, 'user:2');
console.log(`    commit ${second.id} -> version ${store.commit(second).version}`);
const abandoned = store.begin();
store.set(abandoned, 'user:3', 'cy');
console.log(`    ${abandoned.id} 只写了没提交，日志里有它的帧`);
console.log(`    user:1 = ${store.get('user:1').value}，user:2 = ${store.get('user:2')}`);
console.log(`    walBytes=${store.stats().walBytes} frames=${decodeFrames(log.bytes()).frames.length}`);

console.log('[2] 拿日志从头上重开一个 store（等于进程重启）');
const bytes = log.bytes();
const revived = createStore({ log: createMemoryLog(bytes) });
console.log(`    version=${revived.stats().version} keys=${revived.stats().keys}`);
console.log(`    user:3 = ${revived.get('user:3')}，没提交的那次没留下任何东西`);
console.log(`    user:1 在版本 1 上是 ${revived.get('user:1', 1).value}`);

console.log('[3] 尾部那帧写到一半断电（最后 7 个字节没了）');
const cut = createStore({ log: createMemoryLog(bytes.subarray(0, bytes.length - 7)) });
console.log(
  `    recovery reason=${cut.stats().recovery.reason} droppedBytes=${cut.stats().recovery.droppedBytes}（那一帧整个不要）`,
);
console.log(`    version=${cut.stats().version} user:1 = ${cut.get('user:1').value}`);

console.log('[4] checkpoint 把日志收一收');
const smallLog = createMemoryLog(bytes);
const small = createStore({ log: smallLog });
const out = small.checkpoint();
console.log(`    checkpoint version=${out.version} walBytes ${bytes.length} -> ${out.walBytes}`);
const after = createStore({ log: createMemoryLog(smallLog.bytes()) });
console.log(`    重开之后 version=${after.stats().version} keys=${after.stats().keys}`);
console.log(`    user:1 在版本 1 上仍然是 ${after.get('user:1', 1).value}`);
