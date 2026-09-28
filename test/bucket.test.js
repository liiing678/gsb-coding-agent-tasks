import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate } from '../lib/gate.js';
import { createManualClock } from '../lib/clock.js';

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'GateError');
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

function gateWith(bucket, clock) {
  const gate = createGate({ clock });
  gate.register({ tenant: 'acme', bucket });
  return gate;
}

test('桶一开始是满的，花完就拒', () => {
  const clock = createManualClock(0);
  const gate = gateWith({ capacity: 5, refillPerSec: 2 }, clock);
  for (let i = 0; i < 5; i++) {
    assert.equal(gate.check('acme').allowed, true, `第 ${i + 1} 次`);
  }
  const denied = gate.check('acme');
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'bucket');
  assert.equal(denied.remaining.bucketTokens, 0);
});

test('按毫秒线性补，补充不会超过容量', () => {
  const clock = createManualClock(0);
  const gate = gateWith({ capacity: 5, refillPerSec: 10 }, clock);
  gate.check('acme', 5);
  clock.advance(200);
  assert.equal(gate.check('acme').allowed, true);
  assert.equal(gate.stats('acme').tenant.bucket.tokens, 1);
  clock.advance(100000);
  assert.equal(gate.stats('acme').tenant.bucket.tokens, 5);
});

test('小数令牌也对得上：0.5 个每秒', () => {
  const clock = createManualClock(0);
  const gate = gateWith({ capacity: 1, refillPerSec: 0.5 }, clock);
  assert.equal(gate.check('acme').allowed, true);
  clock.advance(333);
  assert.equal(gate.stats('acme').tenant.bucket.tokens, 0.1665);
  assert.equal(gate.check('acme').allowed, false);
  clock.advance(1667);
  assert.equal(gate.check('acme').allowed, true);
});

test('被拒之后要等多久才够：按缺的令牌数算', () => {
  const clock = createManualClock(0);
  const gate = gateWith({ capacity: 5, refillPerSec: 2 }, clock);
  gate.check('acme', 5);
  const denied = gate.check('acme', 3);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 1500);
});

test('一次要的比桶还大，直接算配置错', () => {
  const clock = createManualClock(0);
  const gate = gateWith({ capacity: 5, refillPerSec: 1 }, clock);
  const err = expectError(() => gate.check('acme', 6), 'ERR_COST_TOO_LARGE');
  assert.equal(err.details.limit, 5);
  expectError(() => gate.check('acme', 0), 'ERR_COST_TOO_LARGE');
  expectError(() => gate.check('acme', 1.5), 'ERR_COST_TOO_LARGE');
  expectError(() => gate.check('acme', -2), 'ERR_COST_TOO_LARGE');
});

test('桶的配置本身不合法', () => {
  const clock = createManualClock(0);
  const gate = createGate({ clock });
  expectError(() => gate.register({ tenant: 'a', bucket: { capacity: 0, refillPerSec: 1 } }), 'ERR_BAD_CONFIG');
  expectError(() => gate.register({ tenant: 'a', bucket: { capacity: 5, refillPerSec: 0 } }), 'ERR_BAD_CONFIG');
  expectError(() => gate.register({ tenant: 'a' }), 'ERR_BAD_CONFIG');
  expectError(() => gate.register({ tenant: '' , bucket: { capacity: 5, refillPerSec: 1 } }), 'ERR_BAD_CONFIG');
  gate.register({ tenant: 'a', bucket: { capacity: 5, refillPerSec: 1 } });
  expectError(() => gate.register({ tenant: 'a', bucket: { capacity: 5, refillPerSec: 1 } }), 'ERR_BAD_CONFIG');
  expectError(() => gate.check('nobody'), 'ERR_UNKNOWN_TENANT');
});
