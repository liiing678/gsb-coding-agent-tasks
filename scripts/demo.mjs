import { createCoordinator } from '../lib/coordinator.js';

const state = { now: 1000 };
const coordinator = createCoordinator({
  clock: () => state.now,
  participants: ['p1', 'p2', 'p3'],
  prepareTimeoutMs: 5000,
  retryBackoffMs: 1000,
});
const cards = (messages) => messages.map((one) => `${one.to}:${one.type}`).join(' ');

console.log('twopc demo');

console.log('[1] begin 之后每个参与者都收到 prepare');
coordinator.begin({ id: 't1', ops: [{ k: 'a', v: 1 }] });
console.log(`    ${cards(coordinator.outbox())}`);

console.log('[2] 三个人都投 yes，才拍板提交');
for (const who of ['p1', 'p2', 'p3']) {
  coordinator.receive({ from: who, txnId: 't1', type: 'vote', vote: 'yes' });
}
console.log(`    决定 ${coordinator.status('t1').decision}，发出 ${cards(coordinator.outbox())}`);

console.log('[3] p3 一直不回 ack，过了退避时间就只给它重发');
coordinator.receive({ from: 'p1', txnId: 't1', type: 'ack' });
coordinator.receive({ from: 'p2', txnId: 't1', type: 'ack' });
state.now += 1000;
console.log(`    ${JSON.stringify(coordinator.tick()[0])}`);
console.log(`    重发 ${cards(coordinator.outbox())}`);
coordinator.receive({ from: 'p3', txnId: 't1', type: 'ack' });
console.log(`    t1 状态 ${coordinator.status('t1').state}`);

console.log('[4] 有人投 no 就立刻回滚，不等剩下的人');
coordinator.begin({ id: 't2' });
coordinator.outbox();
coordinator.receive({ from: 'p2', txnId: 't2', type: 'vote', vote: 'no' });
console.log(`    t2 决定 ${coordinator.status('t2').decision}，原因 ${coordinator.status('t2').reason}`);
console.log(`    发出 ${cards(coordinator.outbox())}`);
for (const who of ['p1', 'p2', 'p3']) {
  coordinator.receive({ from: who, txnId: 't2', type: 'ack' });
}

console.log('[5] 票一直没投齐，超时之后回滚');
coordinator.begin({ id: 't3' });
coordinator.outbox();
state.now += 5000;
console.log(`    ${JSON.stringify(coordinator.tick()[0])}`);
coordinator.outbox();
for (const who of ['p1', 'p2', 'p3']) {
  coordinator.receive({ from: who, txnId: 't3', type: 'ack' });
}

console.log('[6] 崩溃恢复：没决策的回滚，决策过的只补发没 ack 的');
coordinator.begin({ id: 't4' });
coordinator.outbox();
for (const who of ['p1', 'p2', 'p3']) {
  coordinator.receive({ from: who, txnId: 't4', type: 'vote', vote: 'yes' });
}
coordinator.outbox();
coordinator.receive({ from: 'p1', txnId: 't4', type: 'ack' });
coordinator.begin({ id: 't5' });
coordinator.outbox();
coordinator.crash();
console.log(`    崩溃前日志里有 ${coordinator.log().length} 条，内存计数已经清零（begun=${coordinator.stats().begun}）`);
console.log(`    恢复 ${coordinator.recover()} 个事务`);
console.log(`    t5 -> ${coordinator.status('t5').decision}/${coordinator.status('t5').reason}`);
console.log(`    t4 -> ${coordinator.status('t4').decision}/${coordinator.status('t4').state}，补发 ${cards(coordinator.outbox())}`);

console.log('[7] 统计');
console.log(`    ${JSON.stringify(coordinator.stats())}`);
