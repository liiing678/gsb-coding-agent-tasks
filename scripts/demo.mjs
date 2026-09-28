import { createDedupStore } from '../lib/dedupstore.js';

const store = createDedupStore({ minBytes: 8, maxBytes: 32, windowBytes: 4, boundaryBits: 3 });
const show = (label, value) => console.log(`    ${label} ${value}`);

function bytes(length, seed = 1) {
  const out = Buffer.alloc(length);
  let state = (seed >>> 0) || 1;
  for (let i = 0; i < length; i += 1) {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    out[i] = state & 0xff;
  }
  return out;
}

console.log('dedupstore demo');

const block = bytes(400, 7);

console.log('[1] 存第一份：块都是新的');
const first = store.putObject({ id: 'v1', data: block });
show('put', JSON.stringify(first));

console.log('[2] 一模一样的内容再存一份：一个新块都不用建');
show('put', JSON.stringify(store.putObject({ id: 'v2', data: Buffer.from(block) })));

console.log('[3] 内容翻倍（同一段拼两遍）：只有多出来的那半段算新块');
show('put', JSON.stringify(store.putObject({ id: 'v3', data: Buffer.concat([block, block]) })));

console.log('[4] 前面插 3 个字节：只有开头那块会变');
const shifted = store.putObject({ id: 'v4', data: Buffer.concat([bytes(3, 99), block]) });
show('put', JSON.stringify(shifted));

console.log('[5] 拿回来跟原样对得上');
show('get', `v3 ${store.getObject({ id: 'v3' }).equals(Buffer.concat([block, block]))}`);

console.log('[6] 快照把对象钉住');
show('snapshot', JSON.stringify(store.createSnapshot({ name: 'nightly', objects: ['v1'] })));
try {
  store.deleteObject({ id: 'v1' });
} catch (err) {
  show('delete', `${err.code} ${err.details.snapshots.join(',')}`);
}

console.log('[7] 删除 + 回收');
store.dropSnapshot({ name: 'nightly' });
show('delete', JSON.stringify(store.deleteObject({ id: 'v1' })));
show('delete', JSON.stringify(store.deleteObject({ id: 'v2' })));
store.deleteObject({ id: 'v3' });
store.deleteObject({ id: 'v4' });
show('gc', JSON.stringify(store.gc()));

console.log('[8] 统计');
console.log(`    ${JSON.stringify(store.stats())}`);
