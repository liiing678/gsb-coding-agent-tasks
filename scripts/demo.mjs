import { expandSeries } from '../lib/expand.js';

const line = (item) =>
  `${item.localDate} ${item.localTime} -> ${item.start}` +
  ` (${item.kind}, ${item.offsetMinutes >= 0 ? '+' : ''}${item.offsetMinutes / 60}h` +
  `${item.modified ? ', 改过' : ''})`;

console.log('calexpand demo');

console.log('[1] 上海，每周一三五 09:00，取四次');
for (const item of expandSeries({
  tz: 'Asia/Shanghai',
  start: '2026-01-05T09:00:00',
  duration: 45,
  rule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=4',
})) {
  console.log(`    ${line(item)}`);
}

console.log('[2] 纽约，每周日 09:00，正好跨过春季跳表');
for (const item of expandSeries({
  tz: 'America/New_York',
  start: '2026-03-01T09:00:00',
  duration: 60,
  rule: 'FREQ=WEEKLY;BYDAY=SU;COUNT=3',
})) {
  console.log(`    ${line(item)}`);
}

console.log('[3] 纽约，凌晨 01:30 每天一次，撞上秋季回拨');
for (const item of expandSeries({
  tz: 'America/New_York',
  start: '2026-10-31T01:30:00',
  duration: 30,
  rule: 'FREQ=DAILY;COUNT=3',
})) {
  console.log(`    ${line(item)}`);
}

console.log('[4] 每月最后一个工作日，中间那次挪到下午');
for (const item of expandSeries({
  tz: 'Asia/Shanghai',
  start: '2026-01-15T18:00:00',
  duration: 30,
  rule: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3',
  overrides: [{ at: '2026-02-27T18:00:00', start: '2026-02-28T10:00:00', duration: 90 }],
})) {
  console.log(`    ${line(item)}`);
}
