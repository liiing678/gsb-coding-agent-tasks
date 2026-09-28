// 演示入口：不需要任何外部服务，自己起一个本地假 origin。
//
//   node bin/cachedemo.js --config configs/dev.json
import { createCache } from '../src/cache.js';
import { loadConfig } from '../src/config.js';
import { createCounters } from '../src/counters.js';
import { createSharedStore } from '../src/shared-store.js';

const argv = process.argv.slice(2);
const configIndex = argv.indexOf('--config');
const configPath = configIndex === -1 ? 'configs/dev.json' : argv[configIndex + 1];

const { cache: config } = loadConfig(configPath);
const counters = createCounters();
const store = createSharedStore();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let loads = 0;
let version = 1;
let delayMs = 0;

// 假 origin：回源一次算一次，慢一点，好让我们在回源途中搞点事。
const loader = async (key) => {
  loads += 1;
  const captured = version; // 回源开始时看到的那一版
  if (delayMs > 0) await sleep(delayMs);
  return { found: true, value: { key, name: `保温杯-v${captured}`, v: captured } };
};

const cache = createCache({
  config,
  counters,
  store,
  loader,
  sleep: (ms) => sleep(ms),
});

const tags = ['category:9'];

console.log('[1] 并发 200 次同一个 key');
const burst = await Promise.all(
  Array.from({ length: 200 }, () => cache.get('product:7', { tags })),
);
console.log(`    回源次数=${loads}`);
console.log(`    200 次拿到的值一样吗 -> ${burst.every((item) => item === burst[0])}`);
console.log(`    值=${JSON.stringify(burst[0])}`);

console.log('');
console.log('[2] 回源途中失效 category:9');
delayMs = 150;
const pending = cache.get('product:9', { tags });
await sleep(30); // 让回源先跑起来
version = 2;
await cache.invalidateTag('category:9');
const during = await pending;
console.log(`    这次 get 拿到 -> ${JSON.stringify(during)}`);
console.log(`    写回缓存了吗 -> ${(await store.get('cache:product:9')) === null ? '没有（被栅栏拦下）' : '写了'}`);
console.log(`    失效之后再 get -> ${JSON.stringify(await cache.get('product:9', { tags }))}`);
delayMs = 0;

console.log('');
console.log('-- counters --');
for (const [name, value] of Object.entries(counters.snapshot())) {
  console.log(`${name}=${value}`);
}
