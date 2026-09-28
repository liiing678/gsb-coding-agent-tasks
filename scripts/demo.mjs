import { createScheduler } from '../lib/scheduler.js';

const FROM = Date.parse('2026-03-01T00:00:00Z');
const TO = Date.parse('2026-03-01T00:06:00Z');
const LAST_ROLLUP = Date.parse('2026-03-01T00:05:00Z');
const hhmm = (at) => new Date(at).toISOString().slice(11, 16);
const hms = (at) => new Date(at).toISOString().slice(11, 19);

const scheduler = createScheduler();
scheduler.defineJob({ id: 'tick', cron: '* * * * *' });
scheduler.defineJob({ id: 'rollup', cron: '*/5 * * * *', dependsOn: ['tick'], retries: 1, backoffMs: 30000 });
scheduler.defineJob({ id: 'digest', cron: '* * * * *', dependsOn: ['rollup'] });

console.log('cronplan demo');

console.log('[1] 窗口里每个任务各自触发几次');
const planned = scheduler.plan({ from: FROM, to: TO });
const label = new Map(planned.map((one) => [one.id, `${one.jobId}@${hhmm(one.at)}`]));
const count = (jobId) => planned.filter((one) => one.jobId === jobId).length;
console.log(`    tick=${count('tick')} rollup=${count('rollup')} digest=${count('digest')}`);

console.log('[2] 依赖指到窗口里最近的那次上游');
const lastDigest = planned.filter((one) => one.jobId === 'digest').at(-1);
console.log(`    ${label.get(lastDigest.id)} <- ${lastDigest.dependsOn.map((id) => label.get(id)).join(' ')}`);

console.log('[3] 跑一轮：最后一次 rollup 一直 retry，重试额度用完就算失败');
const { runs, stats } = scheduler.execute({
  from: FROM,
  to: TO,
  perform: (run) => (run.jobId === 'rollup' && run.at === LAST_ROLLUP ? 'retry' : 'ok'),
});
const failed = runs.find((one) => one.id === `rollup@2026-03-01T${hhmm(LAST_ROLLUP)}Z`);
console.log(`    ${label.get(failed.id)} attempts=${failed.attempts} status=${failed.status} reason=${failed.reason} retryAt=${hms(failed.retryAts[0])}`);

console.log('[4] 挂在失败上游下面的那次跟着跳过');
const skipped = runs.find((one) => one.status === 'skipped');
console.log(`    ${label.get(skipped.id)} status=${skipped.status} reason=${skipped.reason}`);

console.log('[5] 统计');
console.log(`    ${JSON.stringify(stats)}`);
