import http from 'node:http';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { createIdempotency } from './idempotency.js';
import { createMetrics } from './metrics.js';
import { createRecorder } from './recorder.js';

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 演示用的写接口：真干活的占位，等 50 毫秒再回一个新的序号。
export function createDemoHandler({ delayMs = 50 } = {}) {
  let seq = 0;
  return async (req, recorder) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    seq += 1;
    recorder.status(201);
    recorder.setHeader('content-type', 'application/json');
    recorder.setHeader('set-cookie', `seq=${seq}; Path=/`);
    recorder.end(JSON.stringify({ seq, url: req.url }) + '\n');
  };
}

export function createServer({ config, metrics, handler, now }) {
  const middleware = createIdempotency({ config: config.idempotency, metrics, now });

  return http.createServer(async (req, res) => {
    if (req.url === '/_metrics') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(`${JSON.stringify(metrics.snapshot(), null, 2)}\n`);
      return;
    }

    try {
      const body = await readBody(req);
      await middleware.handle({ req, res, body, handler });
    } catch (error) {
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(`${JSON.stringify({
        error: 'internal_error',
        message: String(error?.message ?? error),
      })}\n`);
    }
  });
}

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--config');
  const file = at === -1 ? 'configs/dev.json' : args[at + 1];
  const config = loadConfig(file);
  const metrics = createMetrics();
  const server = createServer({ config, metrics, handler: createDemoHandler() });

  server.listen(config.listen.port, config.listen.host, () => {
    const { port } = server.address();
    console.log(`idemgate 起来了: http://${config.listen.host}:${port}`);
    console.log('  POST /write   （带上 Idempotency-Key 头）');
    console.log('  GET  /_metrics');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
