import { createGate } from '../lib/gate.js';
import { createManualClock } from '../lib/clock.js';

const clock = createManualClock(0);
const gate = createGate({ clock, groups: [{ name: 'pool', window: { sizeMs: 1000, max: 6 } }] });
gate.register({
  tenant: 'acme',
  bucket: { capacity: 4, refillPerSec: 2 },
  window: { sizeMs: 1000, max: 5 },
  shared: 'pool',
});
gate.register({ tenant: 'globex', shared: 'pool', window: { sizeMs: 1000, max: 5 } });

const show = (label, out) =>
  console.log(
    `    ${label}: allowed=${out.allowed} reason=${out.reason} retryAfterMs=${out.retryAfterMs}` +
      ` bucket=${out.remaining.bucketTokens} window=${out.remaining.windowRemaining}` +
      ` shared=${out.remaining.sharedRemaining}`,
  );

console.log('burstgate demo');
console.log('[1] acme 的桶是 4 个，窗口 1 秒 5 个');
for (let i = 1; i <= 5; i++) {
  clock.advance(10);
  show(`第 ${i} 次`, gate.check('acme'));
}

console.log('[2] 等 500 毫秒，桶补回来一点');
clock.advance(500);
show('再来', gate.check('acme'));

console.log('[3] 共享池一共 6 个，globex 用超额了');
for (let i = 1; i <= 3; i++) {
  clock.advance(100);
  show(`globex 第 ${i} 次`, gate.check('globex'));
}

console.log('[4] 时钟被 NTP 往回拨了 5 秒，不能因此白拿额度');
const tokensBefore = gate.stats('acme').tenant.bucket.tokens;
const usedBefore = gate.stats('acme').tenant.window.used;
clock.advance(-5000);
const rolledBack = gate.check('acme');
show('回拨后', rolledBack);
console.log(
  `    at 停在 ${rolledBack.at} 没退回去，令牌 ${tokensBefore} -> ${gate.stats('acme').tenant.bucket.tokens}` +
    `，窗口里已经用掉的 ${usedBefore} 也没被清掉`,
);

console.log('[5] 换一个进程接着限');
const revived = createGate({ clock });
console.log(`    restore -> ${JSON.stringify(revived.restore(gate.snapshot()))}`);
show('接着 acme', revived.check('acme'));
console.log(`    stats allowed=${revived.stats().allowed} denied=${revived.stats().denied}`);
