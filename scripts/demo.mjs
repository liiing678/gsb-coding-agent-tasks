import { createStore } from '../lib/store.js';

const store = createStore();

console.log('mvccstore demo');

console.log('[1] 一个事务里写两条，提交后一起可见');
const first = store.begin();
first.put('a', 1);
first.put('b', 2);
first.commit();
console.log(`    a=${store.get('a')} b=${store.get('b')}`);

console.log('[2] 快照隔离：老事务看不到后来的提交');
const old = store.begin();
const other = store.begin();
other.put('a', 9);
other.commit();
console.log(`    老事务看到 a=${old.get('a')}，最新是 a=${store.get('a')}`);

console.log('[3] 并发写同一个 key，后提交的那个报冲突');
let line = '';
try {
  old.put('a', 100);
  old.commit();
} catch (err) {
  line = `${err.code}: ${err.details.txnId} 写过的 ${err.details.keys.join(',')}`;
}
console.log(`    ${line}`);

console.log('[4] 删掉的 key 留墓碑，读出来是 undefined');
const remover = store.begin();
remover.delete('b');
remover.commit();
console.log(`    b=${store.get('b')} keys=${store.stats().keys}`);

console.log('[5] collect 回收没人要的旧版本');
const collected = store.collect();
console.log(`    回收 ${collected} 条，剩 ${store.stats().versions} 条版本`);

console.log('[6] 统计');
console.log(`    ${JSON.stringify(store.stats())}`);
