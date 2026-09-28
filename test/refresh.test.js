import assert from 'node:assert/strict';
import test from 'node:test';

import { ACCESS_TTL, REFRESH_TTL, SKEW, makeService } from './support/app.js';
import { createFakeClock } from './support/fake-clock.js';

// 每条用例只在验一件事，具体口径看 README 的「refresh 轮换与重放」。

// 换新之后老的那张就得作废；有人拿老的那张再来，按重放处理，整条会话一起废掉。
test('refresh 换新之后旧的那张再来就是重放，整条会话作废', () => {
  const { service, metrics } = makeService();
  const first = service.issue({ sub: 'u1' });
  const second = service.refresh({ refreshToken: first.refreshToken });

  assert.equal(second.sid, first.sid);
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.equal(service.verify(second.accessToken, {}).sub, 'u1');

  assert.throws(() => service.refresh({ refreshToken: first.refreshToken }), {
    code: 'refresh_replayed',
  });
  assert.throws(() => service.verify(second.accessToken, {}), { code: 'session_revoked' });
  assert.throws(() => service.refresh({ refreshToken: second.refreshToken }), {
    code: 'session_revoked',
  });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.refresh_ok_total, 1);
  assert.equal(snapshot.refresh_issued_total, 2);
  assert.equal(snapshot.access_issued_total, 2);
  assert.equal(snapshot.refresh_replayed_total, 1);
  assert.equal(snapshot.session_revoked_total, 1);
});

// 同一张 refresh 连着来两次：只能成功一次，另一次算重放。
test('同一张 refresh 只能成功一次', async () => {
  const { service, metrics } = makeService();
  const first = service.issue({ sub: 'u1' });

  const results = await Promise.allSettled([
    Promise.resolve().then(() => service.refresh({ refreshToken: first.refreshToken })),
    Promise.resolve().then(() => service.refresh({ refreshToken: first.refreshToken })),
  ]);
  const ok = results.filter((result) => result.status === 'fulfilled');
  const failed = results.filter((result) => result.status === 'rejected');

  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.code, 'refresh_replayed');
  assert.equal(metrics.snapshot().refresh_ok_total, 1);
  assert.equal(metrics.snapshot().refresh_replayed_total, 1);

  // 会话已经作废，成功那次换出来的令牌也不认了。
  assert.throws(() => service.verify(ok[0].value.accessToken, {}), { code: 'session_revoked' });
});

// refresh 只能当 refresh 用；它自己过期了就报 expired，别跟会话作废混在一起。
test('refresh 不能当 access 用，自己过期了报 expired', () => {
  const clock = createFakeClock();
  const { service } = makeService({ clock });
  const issued = service.issue({ sub: 'u1' });

  assert.throws(() => service.refresh({ refreshToken: issued.accessToken }), { code: 'wrong_typ' });

  clock.advance(ACCESS_TTL + SKEW + 1);
  assert.equal(service.verify(issued.refreshToken, { typ: 'refresh' }).sub, 'u1');
  assert.throws(() => service.verify(issued.accessToken, {}), { code: 'expired' });

  clock.advance(REFRESH_TTL);
  assert.throws(() => service.refresh({ refreshToken: issued.refreshToken }), { code: 'expired' });
});
