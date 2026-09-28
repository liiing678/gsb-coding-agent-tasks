// HTTP 那层：已实现，别改。把 hub 接到 SSE 上。
//
//   GET  /events?topics=orders,payments&lastEventId=12   -> text/event-stream
//   POST /publish?topic=orders  (body: {"type":"...","data":{...}})  -> 202 {"seq":3}
import http from 'node:http';

import { createCounters } from './counters.js';
import { createHub } from './hub.js';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createServer({ config, counters = createCounters() } = {}) {
  const hub = createHub({ config, counters });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://eventpush.local');

    if (req.method === 'GET' && url.pathname === '/events') {
      const topics = (url.searchParams.get('topics') ?? '').split(',').filter(Boolean);
      const lastEventId = url.searchParams.get('lastEventId') ?? undefined;
      // 订阅成功之前先攒着：响应头（200 + SSE）得先写出去，帧才能往外发。
      const early = [];
      let streaming = false;
      let subscription;
      try {
        subscription = hub.subscribe({
          topics,
          lastEventId,
          send: (frame) => {
            if (streaming) res.write(frame);
            else early.push(frame);
          },
          close: () => {
            res.end();
          },
        });
      } catch (error) {
        res.writeHead(error.code === 'closing' ? 503 : 429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.code ?? 'subscribe_failed' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.flushHeaders(); // SSE：先把响应头吐出去，客户端才能立刻开始收帧
      streaming = true;
      for (const frame of early) res.write(frame);
      req.on('close', () => subscription.close('client_gone'));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/publish') {
      const topic = url.searchParams.get('topic') ?? '';
      let event;
      try {
        event = JSON.parse((await readBody(req)) || '{}');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_json' }));
        return;
      }
      try {
        const result = await hub.publish(topic, event);
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ seq: result.seq }));
      } catch (error) {
        res.writeHead(error.code === 'closing' ? 503 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.code ?? 'publish_failed' }));
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  return { server, hub, counters };
}
