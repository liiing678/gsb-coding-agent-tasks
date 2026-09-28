// 演示入口：本地起一个假上游，拿 guard 打几个调用，最后打一份 snapshot。
// 假上游的脾气：
//   /quota    第一次 503，第二次 200
//   /profile  一直 503
//   /geocode  一直 429，带 Retry-After: 60

import http from 'node:http';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { loadConfig } from '../src/config.js';
import { createCounters } from '../src/counters.js';
import { createGuard } from '../src/guard.js';

export function startDemoUpstream() {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const seen = (hits.get(path) ?? 0) + 1;
    hits.set(path, seen);

    if (path === '/profile') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":"upstream_busy"}\n');
      return;
    }
    if (path === '/geocode') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
      res.end('{"error":"rate_limited"}\n');
      return;
    }
    if (path === '/quota' && seen === 1) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":"upstream_busy"}\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}\n');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--config');
  const file = at === -1 ? 'configs/dev.json' : args[at + 1];
  const config = loadConfig(file).egress;
  const counters = createCounters();
  const guard = createGuard({ config, counters });
  const { server, base } = await startDemoUpstream();

  const steps = [
    { upstream: 'quota', url: `${base}/quota` },
    { upstream: 'profile', url: `${base}/profile` },
    { upstream: 'profile', url: `${base}/profile` },
    { upstream: 'profile', url: `${base}/profile`, waitMs: config.breaker.cooldownMs + 100 },
    { upstream: 'geocode', url: `${base}/geocode` },
  ];

  for (const [index, step] of steps.entries()) {
    const tag = `[${index + 1}] ${step.upstream.padEnd(8)}`;
    if (step.waitMs) {
      console.log(`    (等 ${step.waitMs}ms 冷却)`);
      await new Promise((resolve) => setTimeout(resolve, step.waitMs));
    }
    try {
      const result = await guard.call({ upstream: step.upstream, method: 'GET', url: step.url });
      console.log(`${tag} ok      status=${result.status} attempts=${result.attempts}`);
    } catch (error) {
      const status = error.kind === 'status' ? ` status=${error.status}` : '';
      console.log(
        `${tag} failed  kind=${error.kind}${status} attempts=${error.attempts} reason=${error.reason}`,
      );
    }
  }

  const snapshot = guard.snapshot();
  console.log('\n-- counters --');
  for (const [name, value] of Object.entries(snapshot.counters)) {
    console.log(`${name}=${value}`);
  }
  console.log('\n-- upstreams --');
  for (const [name, info] of Object.entries(snapshot.upstreams)) {
    console.log(`${name.padEnd(8)} state=${info.state} inFlight=${info.inFlight} queued=${info.queued}`);
  }

  server.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
