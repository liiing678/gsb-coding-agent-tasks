import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate } from '../lib/gate.js';
import { createManualClock } from '../lib/clock.js';

function expectError(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`);
    return err;
  }
  assert.fail(`期望抛 ${code}，结果没抛`);
}

test('滑动窗口：正好过了一整个窗口的那条滚出去', () => {
  const clock = createManualClock(0);
  const gate = createGate({ clock });
  gate.register({ tenant: 'acme', window: { sizeMs: 1000, max: 3 } });
  assert.equal(gate.check('acme').allowed, true);
  clock.advance(100);
  assert.equal(gate.check('acme').allowed, true);
  clock.advance(100);
  assert.equal(gate.check('acme').allowed, true);
  const denied = gate.check('acme');
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'window');
  assert.equal(denied.retryAfterMs, 800);
  clock.advance(799);
  assert.equal(gate.check('acme').allowed, false);
  clock.advance(1);
  assert.equal(gate.check('acme').allowed, true);
});

test('窗口不是整段重置，各条记录自己过期', () => {
  const clock = createManualClock(0);
  const gate = createGate({ clock });
  gate.register({ tenant: 'acme', window: { sizeMs: 1000, max: 2 } });
  gate.check('acme');
  clock.advance(600);
  gate.check('acme');
  assert.equal(gate.check('acme').allowed, false);
  clock.advance(400);
  assert.equal(gate.check('acme').allowed, true);
  assert.equal(gate.check('acme').allowed, false);
  clock.advance(600);
  assert.equal(gate.check('acme').allowed, true);
});

test('窗口上限和 cost 的关系', () => {
  const clock = createManualClock(0);
  const gate = createGate({ clock });
  gate.register({ tenant: 'acme', window: { sizeMs: 1000, max: 3 } });
  expectError(() => gate.check('acme', 4), 'ERR_COST_TOO_LARGE');
  expectError(() => gate.register({ tenant: 'b', window: { sizeMs: 0, max: 3 } }), 'ERR_BAD_CONFIG');
  expectError(() => gate.register({ tenant: 'b', window: { sizeMs: 1000, max: 0 } }), 'ERR_BAD_CONFIG');
});

test('共享池：一个租户用光了，另一个也过不去', () => {
  const clock = createManualClock(0);
  const gate = createGate({ clock, groups: [{ name: 'pool', window: { sizeMs: 1000, max: 5 } }] });
  gate.register({ tenant: 'acme', shared: 'pool', window: { sizeMs: 1000, max: 100 } });
  gate.register({ tenant: 'globex', shared: 'pool', window: { sizeMs: 1000, max: 100 } });
  for (let i = 0; i < 4; i++) assert.equal(gate.check('acme').allowed, true);
  assert.equal(gate.check('globex').allowed, true);
  const denied = gate.check('globex');
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'shared');
  assert.deepEqual(denied.blockedBy, ['共享池 pool 的窗口']);
});

test('共享池也得配上，配错了当场报', () => {
  const clock = createManualClock(0);
  const gate = createGate({ clock, groups: [{ name: 'pool', window: { sizeMs: 1000, max: 5 } }] });
  expectError(
    () => gate.register({ tenant: 'acme', shared: 'nope', window: { sizeMs: 1000, max: 5 } }),
    'ERR_BAD_CONFIG',
  );
  expectError(() => createGate({ clock, groups: [{ name: 'empty' }] }), 'ERR_BAD_CONFIG');
  expectError(
    () => createGate({ clock, groups: [{ name: 'a', window: { sizeMs: 1000, max: 5 } }, { name: 'a', window: { sizeMs: 1000, max: 5 } }] }),
    'ERR_BAD_CONFIG',
  );
});
