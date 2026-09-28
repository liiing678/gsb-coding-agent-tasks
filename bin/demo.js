// 演示入口：起一个本地下游，然后拿池子跑几步，不需要任何外部服务。
//
//   npm run demo
import { loadConfig } from '../src/config.js';
import { createCounters } from '../src/counters.js';
import { createPool } from '../src/pool.js';
import { createTcpDriver } from '../src/tcpdriver.js';
import { startMockDownstream } from './mock-downstream.js';

const argv = process.argv.slice(2);
const configIndex = argv.indexOf('--config');
const configPath = configIndex === -1 ? 'configs/dev.json' : argv[configIndex + 1];

const { connlease: config } = loadConfig(configPath);
const downstream = startMockDownstream();
const port = await downstream.listen();
const driver = createTcpDriver({ port });
const counters = createCounters();
const pool = createPool({ config, driver, counters });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('[1] 串行借还 5 次');
for (let i = 1; i <= 5; i += 1) {
  const lease = await pool.acquire();
  const reply = await driver.send(lease.conn, 'PING');
  await lease.release();
  if (i === 1) {
    console.log(`    第一次拿到 ${lease.conn.id}，下游回 ${reply}`);
  }
}
console.log(`    池子 live=${pool.stats().live} idle=${pool.stats().idle} borrowed=${pool.stats().borrowed}`);
console.log(`    下游一共 accept 了 ${downstream.accepted()} 条连接`);

console.log('[2] 同时来 6 个请求，上限是 4');
const held = [];
for (let i = 0; i < config.maxConnections; i += 1) {
  held.push(await pool.acquire());
}
const waiting = [
  pool.acquire().then((lease) => ({ order: 5, lease })),
  pool.acquire().then((lease) => ({ order: 6, lease })),
];
await sleep(50);
console.log(`    借出 ${pool.stats().borrowed}，排队 ${pool.stats().waiters}`);
await held[0].release();
const first = await waiting[0];
console.log(`    还一条出去，排第一个的借到 ${first.lease.conn.id}`);
await held[1].release();
const second = await waiting[1];
console.log(`    再还一条，排第二个的借到 ${second.lease.conn.id}`);
await first.lease.release();
await second.lease.release();
for (const lease of held.slice(2)) {
  await lease.release();
}
console.log(`    全还完：live=${pool.stats().live} idle=${pool.stats().idle}`);

console.log('[3] 借出去忘了还，等租约自己到期');
const leaked = await pool.acquire();
console.log(`    借出 ${leaked.conn.id}，${config.leaseTimeoutMs}ms 之内没人还`);
await sleep(config.leaseTimeoutMs + 250);
console.log(`    租约到期回收 ${counters.snapshot().connlease_lease_expired_total} 条，现在 live=${pool.stats().live}`);

console.log('[4] 还回来的时候说这条连接坏了');
const broken = await pool.acquire();
const brokenId = broken.conn.id;
await broken.release({ broken: true });
const fresh = await pool.acquire();
console.log(`    ${brokenId} 被销毁，下一次借到 ${fresh.conn.id}`);
await fresh.release();

console.log('[5] 关池');
await pool.close();
try {
  await pool.acquire();
} catch (err) {
  console.log(`    关了之后再借 -> ${err.code}`);
}
await downstream.close();

console.log('');
console.log('-- counters --');
for (const [name, value] of Object.entries(counters.snapshot())) {
  console.log(`${name}=${value}`);
}
