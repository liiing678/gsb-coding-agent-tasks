import http from 'node:http';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { TokenError } from './errors.js';
import { createMetrics } from './metrics.js';
import { NotImplementedError, createTokenService } from './tokens.js';

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function statusFor(error) {
  if (error instanceof NotImplementedError) {
    return 501;
  }
  if (error instanceof TokenError) {
    if (error.code === 'invalid_request') {
      return 400;
    }
    if (error.code === 'revocation_capacity_exceeded') {
      return 409;
    }
    return 401;
  }
  return 500;
}

// HTTP 入口：只做路由和 JSON 收发，令牌口径全在 src/tokens.js 里。
// now 只用来把「什么时候过期」换算成 expires_in_ms，默认就是系统时钟。
export function createServer({ config, metrics, service, now = () => Date.now() }) {
  const tokens = service ?? createTokenService({
    config: config.tokens,
    metrics,
    keys: config.keys,
  });

  return http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && path === '/healthz') {
      try {
        send(res, 200, tokens.snapshot());
      } catch (error) {
        send(res, statusFor(error), { error: error?.code ?? 'internal_error' });
      }
      return;
    }

    const routes = {
      '/v1/token': 'issue',
      '/v1/token/refresh': 'refresh',
      '/v1/verify': 'verify',
      '/v1/revoke': 'revoke',
    };
    const action = req.method === 'POST' ? routes[path] : undefined;
    if (!action) {
      send(res, 404, { error: 'not_found' });
      return;
    }

    let payload;
    try {
      const raw = await readBody(req);
      payload = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
    } catch {
      send(res, 400, { error: 'invalid_request' });
      return;
    }

    try {
      if (action === 'issue') {
        const issued = tokens.issue({ sub: payload.sub });
        send(res, 201, {
          access_token: issued.accessToken,
          refresh_token: issued.refreshToken,
          sid: issued.sid,
          expires_in_ms: issued.accessExpiresAt - now(),
        });
        return;
      }
      if (action === 'refresh') {
        const issued = tokens.refresh({ refreshToken: payload.refresh_token });
        send(res, 200, {
          access_token: issued.accessToken,
          refresh_token: issued.refreshToken,
          sid: issued.sid,
          expires_in_ms: issued.accessExpiresAt - now(),
        });
        return;
      }
      if (action === 'verify') {
        try {
          const claims = tokens.verify(payload.token, { typ: payload.typ ?? 'access' });
          send(res, 200, { valid: true, claims });
        } catch (error) {
          if (error instanceof TokenError) {
            send(res, 401, { valid: false, error: error.code });
            return;
          }
          throw error;
        }
        return;
      }
      const result = tokens.revoke({ token: payload.token, scope: payload.scope });
      send(res, 200, result);
    } catch (error) {
      send(res, statusFor(error), {
        error: error?.code ?? 'internal_error',
        message: String(error?.message ?? error),
      });
    }
  });
}

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--config');
  const file = at === -1 ? 'configs/dev.json' : args[at + 1];
  const config = loadConfig(file);
  const metrics = createMetrics();
  const server = createServer({ config, metrics });

  server.listen(config.listen.port, config.listen.host, () => {
    const { port } = server.address();
    console.log(`tokenkeeper 起来了: http://${config.listen.host}:${port}`);
    console.log('  POST /v1/token          （body: {"sub":"u1"}）');
    console.log('  POST /v1/token/refresh  （body: {"refresh_token":"..."}）');
    console.log('  POST /v1/verify         （body: {"token":"..."}）');
    console.log('  POST /v1/revoke         （body: {"token":"...","scope":"session"}）');
    console.log('  GET  /healthz');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
