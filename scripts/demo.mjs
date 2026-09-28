import { createAggregator } from '../lib/stream.js';

const line = (rec) => {
  const values = Object.entries(rec.values)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ');
  console.log(
    `    #${rec.seq} ${rec.state.padEnd(11)} ${rec.key} [${rec.windowStart},${rec.windowEnd}) ${values}`,
  );
};
const dump = (result) => {
  if (result.emitted.length === 0) console.log('    没有输出');
  for (const rec of result.emitted) line(rec);
};
const event = (key, eventTime, bytes) => ({ key, eventTime, values: { bytes } });

console.log('tideflow demo');

console.log('[1] 同一个窗口里连着收，边收边更新');
const agg = createAggregator({
  windowMs: 1000,
  watermarkDelayMs: 0,
  allowedLatenessMs: 500,
  aggregations: ['count', 'sum:bytes', 'avg:bytes'],
});
dump(agg.push(event('tenant-a', 100, 10)));
dump(agg.push(event('tenant-a', 900, 20)));

console.log('[2] 虽然迟到，但还在宽限期里，补进窗口 0');
dump(agg.push(event('tenant-a', 300, 6)));

console.log('[3] 水位走到宽限期，窗口关掉发 final');
dump(agg.push(event('tenant-b', 1500, 7)));

console.log('[4] 迟到太久，直接丢掉');
dump(agg.push(event('tenant-a', 100, 99)));
console.log(`    lateDropped=${agg.stats().lateDropped}`);

console.log('[5] 收尾：把还开着的都收掉，再统计');
dump(agg.flush());
const stats = agg.stats();
console.log(
  `    watermark=${stats.watermark} windows=${stats.windows} open=${stats.openWindows} ` +
    `closed=${stats.closedWindows} emitted=${stats.emitted}`,
);
