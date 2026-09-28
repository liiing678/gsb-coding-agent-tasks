// 演示入口：不需要任何外部服务，自己起一个本地 HTTP 服务，连两个 SSE 客户端。
//
//   node bin/eventpush.js --config configs/dev.json
import http from 'node:http';

import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

const argv = process.argv.slice(2);
const configIndex = argv.indexOf('--config');
const configPath = configIndex === -1 ? 'configs/dev.json' : argv[configIndex + 1];

const { eventpush: config } = loadConfig(configPath);
const { server, counters } = createServer({ config });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseFrame(raw) {
  const fields = { id: '', event: 'message', data: '' };
  for (const line of raw.split('\n')) {
    if (line.startsWith('id: ')) fields.id = line.slice(4);
    else if (line.startsWith('event: ')) fields.event = line.slice(7);
    else if (line.startsWith('data: ')) fields.data = line.slice(6);
  }
  return fields;
}

function connect(query) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}/events?${query}`, (response) => {
      const frames = [];
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n\n');
        while (index !== -1) {
          frames.push(parseFrame(buffer.slice(0, index)));
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf('\n\n');
        }
      });
      resolve({ frames, stop: () => request.destroy() });
    });
    request.on('error', reject);
  });
}

async function publish(topic, type, data) {
  await fetch(`${base}/publish?topic=${topic}`, {
    method: 'POST',
    body: JSON.stringify({ type, data }),
  });
}

const show = (frames, from = 0) => {
  for (const frame of frames.slice(from)) {
    console.log(`    <- id=${frame.id} ${frame.event} ${frame.data}`);
  }
};

console.log('[1] 一个客户端订阅 orders');
const first = await connect('topics=orders');
await sleep(50);
await publish('orders', 'order.created', { id: 7 });
await publish('orders', 'order.paid', { id: 7 });
await sleep(80);
show(first.frames);

console.log('[2] 第二个客户端带 Last-Event-ID: 1 重连');
const second = await connect('topics=orders&lastEventId=1');
await sleep(50);
await publish('orders', 'order.shipped', { id: 7 });
await sleep(80);
show(second.frames);

console.log('[3] 发一个没人订阅的 topic');
await publish('payments', 'payment.ok', { id: 9 });
await sleep(80);
console.log(`    第一个客户端收到 ${first.frames.length} 帧，第二个收到 ${second.frames.length} 帧`);

first.stop();
second.stop();
await sleep(30);
await server.close();

console.log('');
console.log('-- counters --');
for (const [name, value] of Object.entries(counters.snapshot())) {
  console.log(`${name}=${value}`);
}
