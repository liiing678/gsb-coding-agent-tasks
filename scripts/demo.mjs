import { createDeadlockDetector } from '../lib/waitgraph.js';

let now = 0;
const detector = createDeadlockDetector({ clock: () => now, maxWaitMs: 100 });
const show = (label, value) => console.log(`    ${label} ${value}`);

console.log('waitgraph demo');

console.log('[1] 资源空着就先到先得');
detector.register({ txId: 't1', startedAt: 0 });
detector.register({ txId: 't2', startedAt: 10 });
detector.register({ txId: 't3', startedAt: 20 });
show('grant', JSON.stringify(detector.wait({ txId: 't1', resource: 'row-7' })));

console.log('[2] 后来的人在后面排队');
show('queue', `t2 等 ${detector.wait({ txId: 't2', resource: 'row-7' }).waitingFor}`);
show('queue', `t3 等 ${detector.wait({ txId: 't3', resource: 'row-7' }).waitingFor}`);
show('waiters', detector.snapshot().resources[0].waiters.join(','));

console.log('[3] 释放时按 FIFO 交给最早排队的人');
show('handoff', JSON.stringify(detector.release({ txId: 't1', resource: 'row-7' })));

console.log('[4] 互相等待：检测出环，最年轻的那个被 abort');
detector.register({ txId: 't4', startedAt: 30 });
detector.register({ txId: 't5', startedAt: 40 });
detector.wait({ txId: 't4', resource: 'row-9' });
detector.wait({ txId: 't5', resource: 'row-11' });
detector.wait({ txId: 't4', resource: 'row-11' });
detector.wait({ txId: 't5', resource: 'row-9' });
const found = detector.detect();
show('cycles', JSON.stringify(found.cycles));
show('victims', found.victims.join(','));
show('after', detector.snapshot().resources.map((one) => `${one.resource}:${one.holder}`).join(' '));

console.log('[5] 等太久算超时');
now = 101;
show('timeouts', detector.detect().timeouts.join(','));

console.log('[6] 统计');
console.log(`    ${JSON.stringify(detector.stats())}`);
