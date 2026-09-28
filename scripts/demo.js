// 演示入口：用手动时钟把几天的时间快进过去，看看调度器在夏令时那两天怎么跑。
//
//   npm run demo
import { loadConfig } from '../lib/config.js';
import { createCounters } from '../lib/counters.js';
import { createManualClock } from '../lib/manual-clock.js';
import { createScheduler } from '../lib/scheduler.js';

const argv = process.argv.slice(2);
const configIndex = argv.indexOf('--config');
const configPath = configIndex === -1 ? 'configs/dev.json' : argv[configIndex + 1];

const { tickwheel: config } = loadConfig(configPath);
const timeZone = config.timeZone;

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function localText(ms) {
  const parts = formatter.formatToParts(new Date(ms));
  const value = {};
  for (const part of parts) {
    value[part.type] = part.value;
  }
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}`;
}

function utcText(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function phase(title, { start, cron, advanceMs, jobName = 'job' }) {
  console.log(title);
  const clock = createManualClock(start);
  const counters = createCounters();
  const scheduler = createScheduler({ config, counters, now: clock.now, sleep: clock.sleep });
  const fired = [];
  scheduler.add({
    name: jobName,
    cron,
    run: (at) => {
      fired.push(at);
      console.log(`    ${localText(at)}  (${utcText(at)})`);
    },
  });
  scheduler.start();
  await clock.advance(advanceMs);
  await scheduler.stop();
  console.log(`    一共跑了 ${fired.length} 次`);
  return { counters, fired };
}

await phase('[1] 每天 09:00，跨一次夏令时', {
  start: Date.UTC(2026, 2, 6, 12, 0),
  cron: '0 9 * * *',
  advanceMs: 3 * 86400000 + 12 * 3600000,
  jobName: 'open',
});

await phase('[2] 每天 02:30，3 月 8 日这天本地没有 02:30', {
  start: Date.UTC(2026, 2, 7, 12, 0),
  cron: '30 2 * * *',
  advanceMs: 2 * 86400000,
  jobName: 'nightly',
});

await phase('[3] 每天 01:30，11 月 1 日这天 01:30 会出现两次', {
  start: Date.UTC(2026, 9, 31, 12, 0),
  cron: '30 1 * * *',
  advanceMs: 2 * 86400000,
  jobName: 'report',
});

console.log('[4] 每 10 分钟一次，但这一次跑不完');
{
  const clock = createManualClock(Date.UTC(2026, 0, 1, 0, 0));
  const counters = createCounters();
  const scheduler = createScheduler({ config: { timeZone: 'UTC' }, counters, now: clock.now, sleep: clock.sleep });
  let release;
  let started = 0;
  scheduler.add({
    name: 'slow',
    cron: '*/10 * * * *',
    run: () => {
      started += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  scheduler.start();
  await clock.advance(35 * 60000);
  await sleep(20);
  console.log(`    真开了 ${started} 次，跳过了 ${counters.snapshot().tickwheel_overlap_skipped_total} 次`);

  const stopping = scheduler.stop();
  let drained = false;
  stopping.then(() => {
    drained = true;
  });
  await sleep(20);
  console.log(`    stop() 的时候那次还没跑完 -> ${!drained}`);
  release();
  await stopping;
  console.log('    stop() 回来了');
  await clock.advance(30 * 60000);
  console.log(`    再推进 30 分钟，一共还是开了 ${started} 次`);
}
