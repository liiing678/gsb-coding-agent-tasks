import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate } from '../lib/gate.js';
import { createManualClock } from '../lib/clock.js';

function setup() {
  const clock = createManualClock(0);
  const gate = createGate({ clock, groups: [{ name: 'pool', window: { sizeMs: 1000, max: 10 } }] });
  gate.register({
    tenant: 'acme',
    bucket: { capacity: 20, refillPerSec: 1 },
    window: { sizeMs: 1000, max: 3 },
    shared: 'pool',
  });
  gate.register({ tenant: 'solo', bucket: { capacity: 2, refillPerSec: 1 } });
  return { clock, gate };
}

test('两道上限都要过，报的是先挡住的那道', () => {
  const { clock, gate } = setup();
  assert.equal(gate.check('solo').allowed, true);
  assert.equal(gate.check('solo').allowed, true);
  const denied = gate.check('solo');
  assert.equal(denied.reason, 'bucket');
  clock.advance(1000);
  assert.equal(gate.check('solo').allowed, true);
});

test('桶够、窗口不够的时候报 window', () => {
  const { clock, gate } = setup();
  assert.equal(gate.check('acme').allowed, true);
  assert.equal(gate.check('acme').allowed, true);
  assert.equal(gate.check('acme').allowed, true);
  const denied = gate.check('acme');
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'window');
  assert.equal(denied.retryAfterMs, 1000);
  assert.equal(denied.remaining.windowRemaining, 0);
  clock.advance(1000);
  assert.equal(gate.check('acme').allowed, true);
});

test('checkMany：一个过不去就都不消耗', () => {
  const { clock, gate } = setup();
  const first = gate.checkMany([
    { tenant: 'solo', cost: 2 },
    { tenant: 'acme', cost: 3 },
  ]);
  assert.equal(first.allowed, true);
  assert.deepEqual(first.results.map((item) => item.allowed), [true, true]);

  clock.advance(10);
  const second = gate.checkMany([
    { tenant: 'solo', cost: 2 },
    { tenant: 'acme', cost: 3 },
  ]);
  assert.equal(second.allowed, false);
  assert.equal(second.results[0].allowed, false);
  assert.equal(gate.stats('solo').tenant.bucket.tokens, 0.01);
  assert.equal(gate.stats('acme').tenant.window.used, 3);
});

test('checkMany 之后本来能过的那次还是能过', () => {
  const { gate } = setup();
  const blocked = gate.checkMany([
    { tenant: 'solo', cost: 2 },
    { tenant: 'solo', cost: 2 },
  ]);
  assert.equal(blocked.allowed, false);
  assert.equal(gate.check('solo', 2).allowed, true);
  assert.equal(gate.check('solo', 1).allowed, false);
});

test('时钟回拨：不白给令牌，也不丢窗口记录', () => {
  const { clock, gate } = setup();
  gate.check('solo', 2);
  clock.advance(500);
  gate.check('acme');
  const before = gate.stats('solo').tenant.bucket.tokens;
  clock.advance(-5000);
  const after = gate.check('solo', 1);
  assert.equal(after.allowed, false);
  assert.equal(after.at, 500);
  assert.equal(gate.stats('solo').tenant.bucket.tokens, before);
});

test('stats 把两个租户和拒绝原因都数出来', () => {
  const { clock, gate } = setup();
  gate.check('solo', 2);
  gate.check('solo');
  clock.advance(10);
  gate.check('acme');
  const stats = gate.stats();
  assert.equal(stats.tenants, 2);
  assert.equal(stats.groups, 1);
  assert.equal(stats.allowed, 2);
  assert.equal(stats.denied, 1);
  assert.equal(stats.byReason.bucket, 1);
  assert.equal(stats.perTenant.solo.bucket.tokens, 0.01);
  assert.equal(stats.perTenant.acme.window.used, 1);
});

test('换个进程接着限：快照搬过去，桶和窗口都接上', () => {
  const { clock, gate } = setup();
  gate.check('acme', 2);
  clock.advance(200);
  const state = JSON.parse(JSON.stringify(gate.snapshot()));
  const revived = createGate({ clock });
  const out = revived.restore(state);
  assert.deepEqual(out, { tenants: 2, groups: 1 });
  assert.equal(revived.stats('acme').tenant.window.used, 2);
  assert.equal(revived.check('acme', 2).allowed, false);
  assert.equal(revived.check('acme', 1).allowed, true);
  assert.equal(revived.check('solo', 2).allowed, true);
  let code = '';
  try {
    revived.restore({ version: 9 });
  } catch (err) {
    code = err.code;
  }
  assert.equal(code, 'ERR_BAD_SNAPSHOT');
});
