import assert from 'node:assert/strict';
import test from 'node:test';

import { ACCESS_TTL, REFRESH_TTL, SKEW, makeService } from './support/app.js';
import { createFakeClock } from './support/fake-clock.js';

// 每条用例只在验一件事，具体口径看 README 的「撤销」和「会话与内存」。

// 撤单条只拉黑这一张，同一条会话里别的令牌照旧。
test('撤单条只影响那一张，同会话的 refresh 还能用', () => {
  const { service, metrics } = makeService();
  const issued = service.issue({ sub: 'u1' });
  const rotated = service.refresh({ refreshToken: issued.refreshToken });

  assert.deepEqual(service.revoke({ token: rotated.accessToken, scope: 'token' }), {
    revoked: true,
    scope: 'token',
  });
  assert.throws(() => service.verify(rotated.accessToken, {}), { code: 'revoked' });

  const again = service.refresh({ refreshToken: rotated.refreshToken });
  assert.equal(service.verify(again.accessToken, {}).sub, 'u1');

  assert.equal(metrics.snapshot().token_revoked_total, 1);
  assert.equal(metrics.snapshot().session_revoked_total, 0);
  assert.equal(service.snapshot().revocations, 1);
});

// 撤整条会话：这条会话里 access 和 refresh 全不认。
test('撤整条会话，access 和 refresh 都不认', () => {
  const { service, metrics } = makeService();
  const issued = service.issue({ sub: 'u1' });

  assert.deepEqual(service.revoke({ token: issued.refreshToken, scope: 'session' }), {
    revoked: true,
    scope: 'session',
  });
  assert.throws(() => service.verify(issued.accessToken, {}), { code: 'session_revoked' });
  assert.throws(() => service.refresh({ refreshToken: issued.refreshToken }), {
    code: 'session_revoked',
  });
  assert.equal(metrics.snapshot().session_revoked_total, 1);
  assert.equal(metrics.snapshot().token_revoked_total, 0);
});

// 拿已经过期的令牌来撤销：不报错、不占容量。
test('拿已经过期的令牌来撤销就跳过，不占容量', () => {
  const clock = createFakeClock();
  const { service, metrics } = makeService({ clock });
  const issued = service.issue({ sub: 'u1' });

  clock.advance(ACCESS_TTL + SKEW + 1);
  assert.deepEqual(service.revoke({ token: issued.accessToken, scope: 'token' }), {
    revoked: false,
    scope: 'token',
    reason: 'expired',
  });
  assert.equal(metrics.snapshot().revoke_skipped_total, 1);

  for (let i = 0; i < 4; i += 1) {
    const other = service.issue({ sub: `u${i}` });
    service.revoke({ token: other.accessToken, scope: 'token' });
  }
  assert.throws(() => {
    const extra = service.issue({ sub: 'u9' });
    service.revoke({ token: extra.accessToken, scope: 'token' });
  }, { code: 'revocation_capacity_exceeded' });
  assert.equal(metrics.snapshot().revocation_rejected_total, 1);
  assert.equal(service.snapshot().revocations, 4);
});

// 撤销条目过期就腾出容量；顶到上限时宁可拒绝新的，也不许把没过期的挤掉。
test('撤销表顶到上限就拒绝新的，过期的腾出容量', () => {
  const clock = createFakeClock();
  const { service, metrics } = makeService({ clock });

  for (let i = 0; i < 4; i += 1) {
    const issued = service.issue({ sub: `u${i}` });
    service.revoke({ token: issued.accessToken, scope: 'token' });
  }
  const fifth = service.issue({ sub: 'u5' });
  assert.throws(() => service.revoke({ token: fifth.accessToken, scope: 'token' }), {
    code: 'revocation_capacity_exceeded',
  });
  assert.equal(metrics.snapshot().token_revoked_total, 4);
  assert.equal(metrics.snapshot().revocation_rejected_total, 1);
  // 前四条都还在有效期内，一个都不能被挤掉。
  assert.equal(service.snapshot().revocations, 4);

  clock.advance(ACCESS_TTL + SKEW + 1);
  const fresh = service.issue({ sub: 'u6' });
  assert.deepEqual(service.revoke({ token: fresh.accessToken, scope: 'token' }), {
    revoked: true,
    scope: 'token',
  });
  assert.equal(service.snapshot().revocations, 1);
});

// 会话不能只涨不落：refresh 也过期的会话，下次进服务就该清掉。
test('过期的会话会被清掉，snapshot 里的条数收敛', () => {
  const clock = createFakeClock();
  const { service } = makeService({ clock });
  for (let i = 0; i < 3; i += 1) {
    service.issue({ sub: `u${i}` });
  }

  clock.advance(REFRESH_TTL + SKEW + 1);
  service.issue({ sub: 'later' });

  assert.equal(service.snapshot().sessions, 1);
  assert.equal(service.snapshot().signingKid, 'k2');
});
