import assert from 'node:assert/strict';
import test from 'node:test';

import { ACCESS_TTL, DEV_KEYS, SKEW, postJson, makeService, startApp } from './support/app.js';
import { accessPayload, craftToken, decodeSegment } from './support/craft.js';
import { createFakeClock } from './support/fake-clock.js';

// 每条用例只在验一件事，具体口径看 README 的「口径」那几节。

// 签出来的东西能验过、claims 对得上，access 和 refresh 不能互相顶用。
test('签发的令牌能验过，claims 对得上，类型不能串用', () => {
  const { service, metrics } = makeService();
  assert.throws(() => service.issue({}), { code: 'invalid_request' });

  const issued = service.issue({ sub: 'u1' });
  const claims = service.verify(issued.accessToken, { typ: 'access' });
  const refresh = service.verify(issued.refreshToken, { typ: 'refresh' });

  assert.equal(claims.sub, 'u1');
  assert.equal(claims.typ, 'access');
  assert.equal(claims.iss, 'tokenkeeper-test');
  assert.equal(claims.sid, issued.sid);
  assert.equal(claims.exp - claims.iat, ACCESS_TTL);
  assert.equal(refresh.sid, issued.sid);
  assert.notEqual(refresh.jti, claims.jti);

  const header = decodeSegment(issued.accessToken, 0);
  assert.equal(header.alg, 'HS256');
  assert.equal(header.kid, 'k2');

  assert.throws(() => service.verify(issued.refreshToken, { typ: 'access' }), { code: 'wrong_typ' });
  assert.equal(metrics.snapshot().access_issued_total, 1);
  assert.equal(metrics.snapshot().refresh_issued_total, 1);
  assert.equal(metrics.snapshot().verify_ok_total, 2);
});

// 格式、签名、kid 各自要报各自的 code，不能都糊成一句「校验失败」。
test('坏格式、坏签名、未知 kid 报各自的 code', () => {
  const { service, metrics } = makeService();
  const issued = service.issue({ sub: 'u1' });
  const [header, payload, signature] = issued.accessToken.split('.');

  assert.throws(() => service.verify('nope', {}), { code: 'invalid_token' });
  assert.throws(() => service.verify(`${header}.${payload}`, {}), { code: 'invalid_token' });
  assert.throws(
    () => service.verify(`${header}.${Buffer.from('{oops').toString('base64url')}.${signature}`, {}),
    { code: 'invalid_token' },
  );

  const flipped = `${header}.${payload}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => service.verify(flipped, {}), { code: 'bad_signature' });

  const unknownKid = craftToken({
    kid: 'k9',
    secret: 'whatever-secret',
    payload: accessPayload({ iss: 'tokenkeeper-test', iat: 0, ttlMs: ACCESS_TTL }),
  });
  assert.throws(() => service.verify(unknownKid, {}), { code: 'unknown_kid' });

  const noneAlg = craftToken({
    kid: 'k2',
    secret: DEV_KEYS[0].secret,
    alg: 'none',
    payload: accessPayload({ iss: 'tokenkeeper-test', iat: 0, ttlMs: ACCESS_TTL }),
  });
  assert.throws(() => service.verify(noneAlg, {}), { code: 'invalid_token' });

  assert.equal(metrics.snapshot().verify_rejected_total, 6);
});

// 过期要等容差走完才算，iat 跑到容差外面的未来一样不认。
test('过期和时钟容差按口径来，iss 不对也要单独报', () => {
  const clock = createFakeClock();
  const { service, metrics } = makeService({ clock });
  const issued = service.issue({ sub: 'u1' });

  clock.advance(ACCESS_TTL + SKEW - 1);
  service.verify(issued.accessToken, {});
  clock.advance(2);
  assert.throws(() => service.verify(issued.accessToken, {}), { code: 'expired' });

  const now = clock.now();
  const fromFuture = craftToken({
    kid: 'k2',
    secret: DEV_KEYS[0].secret,
    payload: accessPayload({ iss: 'tokenkeeper-test', iat: now + 60000, ttlMs: ACCESS_TTL }),
  });
  assert.throws(() => service.verify(fromFuture, {}), { code: 'not_yet_valid' });

  const strangerIssuer = craftToken({
    kid: 'k2',
    secret: DEV_KEYS[0].secret,
    payload: accessPayload({ iss: 'someone-else', iat: now, ttlMs: ACCESS_TTL }),
  });
  assert.throws(() => service.verify(strangerIssuer, {}), { code: 'wrong_issuer' });

  assert.equal(metrics.snapshot().verify_ok_total, 1);
  assert.equal(metrics.snapshot().verify_rejected_total, 3);
});

// 滚动密钥：新的上来签，老的留过渡期只验；过渡期一过报 key_expired，拿掉报 unknown_kid。
test('密钥轮换：老令牌过渡期内还能验，过了就不认', () => {
  const clock = createFakeClock();
  const { service } = makeService({ clock });
  const old = service.issue({ sub: 'u1' });

  const k3 = { kid: 'k3', secret: 'test-secret-k3', state: 'active', verifyUntil: null };
  service.reloadKeys([
    k3,
    {
      ...DEV_KEYS[0],
      state: 'verifyOnly',
      verifyUntil: new Date(clock.now() + 60000).toISOString(),
    },
  ]);

  const fresh = service.issue({ sub: 'u2' });
  assert.equal(decodeSegment(fresh.accessToken, 0).kid, 'k3');
  assert.equal(service.verify(old.accessToken, {}).sub, 'u1');

  clock.advance(60001);
  assert.throws(() => service.verify(old.accessToken, {}), { code: 'key_expired' });

  service.reloadKeys([k3]);
  assert.throws(() => service.verify(old.accessToken, {}), { code: 'unknown_kid' });
  assert.equal(service.snapshot().signingKid, 'k3');
});

// HTTP 入口就照 README 里那几条 curl 走一遍。
test('HTTP 入口：发令牌、验令牌、撤会话、看 healthz', async () => {
  const app = await startApp();
  try {
    const missingSub = await postJson(app.base, '/v1/token', {});
    assert.equal(missingSub.status, 400);
    assert.equal((await missingSub.json()).error, 'invalid_request');

    const issued = await postJson(app.base, '/v1/token', { sub: 'u1' });
    assert.equal(issued.status, 201);
    const body = await issued.json();
    assert.equal(body.expires_in_ms, ACCESS_TTL);
    assert.ok(body.refresh_token);

    const verified = await postJson(app.base, '/v1/verify', { token: body.access_token });
    assert.equal(verified.status, 200);
    assert.equal((await verified.json()).valid, true);

    const rejected = await postJson(app.base, '/v1/verify', { token: 'nope' });
    assert.equal(rejected.status, 401);
    assert.deepEqual(await rejected.json(), { valid: false, error: 'invalid_token' });

    const revoked = await postJson(app.base, '/v1/revoke', {
      token: body.access_token,
      scope: 'session',
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual(await revoked.json(), { revoked: true, scope: 'session' });

    const after = await postJson(app.base, '/v1/verify', { token: body.access_token });
    assert.equal(after.status, 401);
    assert.equal((await after.json()).error, 'session_revoked');

    const health = await fetch(`${app.base}/healthz`);
    const healthBody = await health.json();
    assert.equal(healthBody.signingKid, 'k2');
    assert.equal(healthBody.sessions, 1);
    assert.equal(healthBody.counters.session_revoked_total, 1);
  } finally {
    await app.close();
  }
});
