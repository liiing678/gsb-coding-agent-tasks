import test from 'node:test';
import assert from 'node:assert/strict';

import { createMachine, run, DEFAULTS } from '../lib/stateflow.js';
import { code, job, shown } from './util.js';

test('viaHistory 恢复上次在这个复合状态里的叶子', () => {
  const machine = createMachine(job);
  machine.send('START');
  machine.send('SLOW');

  const paused = machine.send('PAUSE');
  assert.deepEqual(shown(paused.trace), ['exit:slow', 'exit:running', 'enter:paused']);
  assert.deepEqual(paused.active, ['job', 'paused']);

  const resumed = machine.send('RESUME');
  assert.deepEqual(shown(resumed.trace), ['exit:paused', 'enter:running', 'enter:slow']);
  assert.deepEqual(resumed.active, ['job', 'running', 'slow']);
});

test('自转换走初始链，不吃历史', () => {
  const machine = createMachine(job);
  machine.send('START');
  machine.send('SLOW');
  const restarted = machine.send('RESTART');
  assert.deepEqual(shown(restarted.trace),
    ['exit:slow', 'exit:running', 'enter:running', 'enter:fast']);
  assert.deepEqual(restarted.active, ['job', 'running', 'fast']);

  // 同一条机器里，viaHistory 的转换还是能吃到刚才记下的 slow
  machine.send('SLOW');
  machine.send('PAUSE');
  assert.deepEqual(machine.send('RESUME').active, ['job', 'running', 'slow']);
});

test('raise 排的队下一次 send 先处理，外部事件排后面', () => {
  const definition = {
    id: 'job',
    initial: 'idle',
    states: [
      { id: 'idle', on: { GO: 'one' } },
      { id: 'one', on: { TICK: 'two' } },
      { id: 'two', on: { TOCK: 'done' } },
      { id: 'done', final: true },
    ],
  };
  const machine = createMachine(definition);
  machine.send('GO');
  machine.raise('TICK');
  machine.raise('TOCK');
  const result = machine.send('GO');
  assert.deepEqual(result.handled, ['TICK', 'TOCK', 'GO']);
  assert.equal(result.matched, false);
  assert.deepEqual(result.active, ['job', 'done']);
  assert.deepEqual(result.queued, []);
  assert.deepEqual(shown(result.trace), ['exit:one', 'enter:two', 'exit:two', 'enter:done']);
});

test('自己喂自己喂太多就停下', () => {
  const machine = createMachine({
    id: 'job',
    initial: 'idle',
    states: [{ id: 'idle', on: { GO: 'idle' } }],
  });
  for (let index = 0; index < DEFAULTS.maxSteps; index += 1) {
    machine.raise('GO');
  }
  assert.equal(machine.state().queued.length, DEFAULTS.maxSteps);
  assert.equal(code(() => machine.send('GO')), 'ERR_TOO_MANY_EVENTS');
  assert.equal(DEFAULTS.maxSteps, 100);
});

test('run 串一串事件，active / handled / context 都对得上', () => {
  const result = run(job, ['START', 'SLOW', 'PAUSE', 'RESUME', 'DONE', 'RESTART'], {
    context: { retry: 0 },
  });
  assert.equal(result.results.length, 6);
  assert.deepEqual(result.results.map((one) => one.matched),
    [true, true, true, true, true, false]);
  assert.deepEqual(result.handled,
    ['START', 'SLOW', 'PAUSE', 'RESUME', 'DONE', 'RESTART']);
  assert.deepEqual(result.results[3].active, ['job', 'running', 'slow']);
  assert.deepEqual(result.active, ['job', 'done']);
  assert.equal(result.done, true);
  assert.deepEqual(result.context, { retry: 0 });
  assert.equal(code(() => run(job, 'START')), 'ERR_BAD_EVENT');
});
