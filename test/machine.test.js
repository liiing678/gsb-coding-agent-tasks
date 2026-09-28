import test from 'node:test';
import assert from 'node:assert/strict';

import { createMachine } from '../lib/stateflow.js';
import { code, job, shown } from './util.js';

test('建起来就是初始链，返回的东西改不动里面那份', () => {
  const machine = createMachine(job, { context: { retry: 0 } });
  const state = machine.state();
  assert.deepEqual(state.active, ['job', 'idle']);
  assert.deepEqual(state.context, { retry: 0 });
  assert.equal(state.done, false);
  assert.deepEqual(state.queued, []);

  state.active.push('running');
  state.context.retry = 9;
  assert.deepEqual(machine.state().active, ['job', 'idle']);
  assert.equal(machine.state().context.retry, 0);
});

test('转换的退出从内到外，进入从外到内', () => {
  const machine = createMachine(job);
  const result = machine.send('START');
  assert.equal(result.matched, true);
  assert.deepEqual(result.handled, ['START']);
  assert.deepEqual(shown(result.trace), ['exit:idle', 'enter:running', 'enter:fast']);
  assert.deepEqual(result.active, ['job', 'running', 'fast']);
  assert.deepEqual(result.context, {});
  assert.equal(result.done, false);

  const inner = machine.send('SLOW');
  // fast 和 slow 的公共祖先是 running，keep 是它的父状态 job，
  // 所以 running 也要退出来再重新进去，只是这次进去直接落到了 slow
  assert.deepEqual(shown(inner.trace),
    ['exit:fast', 'exit:running', 'enter:running', 'enter:slow']);
  assert.deepEqual(inner.active, ['job', 'running', 'slow']);
});

test('在祖先上命中的转换会把那一支整个退掉', () => {
  const machine = createMachine(job);
  machine.send('START');
  machine.send('SLOW');
  const result = machine.send('DONE');
  assert.deepEqual(shown(result.trace), ['exit:slow', 'exit:running', 'enter:done']);
  assert.deepEqual(result.active, ['job', 'done']);
  assert.equal(result.done, true);

  // final 自己不匹配事件，祖先也不管这个事件，机器就一动不动
  const stray = machine.send('START');
  assert.equal(stray.matched, false);
  assert.deepEqual(stray.trace, []);
  assert.deepEqual(stray.handled, ['START']);
  assert.deepEqual(stray.active, ['job', 'done']);
});

test('同一个事件给了多条转换时按顺序挑第一个 when 满足的', () => {
  const definition = {
    id: 'job',
    initial: 'idle',
    states: [
      {
        id: 'idle',
        on: {
          GO: [
            { target: 'quick', when: { fast: true } },
            { target: 'slow', when: { retry: 2 } },
            'done',
          ],
        },
      },
      { id: 'quick' },
      { id: 'slow' },
      { id: 'done', final: true },
    ],
  };

  const quick = createMachine(definition, { context: { fast: true, retry: 2 } });
  assert.deepEqual(quick.send('GO').active, ['job', 'quick']);

  const slow = createMachine(definition, { context: { retry: 2 } });
  assert.deepEqual(slow.send('GO').active, ['job', 'slow']);

  const fallback = createMachine(definition, { context: { retry: 1 } });
  assert.deepEqual(fallback.send('GO').active, ['job', 'done']);

  // when 里每个键都要对上才算
  const partial = createMachine(definition, { context: { fast: true, retry: 2 } });
  assert.deepEqual(partial.send('GO').active, ['job', 'quick']);
});

test('assign 在退出之后、进入之前写进去', () => {
  const definition = {
    id: 'job',
    initial: 'idle',
    states: [
      { id: 'idle', on: { GO: { target: 'work', assign: { phase: 'work', tries: 1 } } } },
      { id: 'work', on: { PING: { target: 'pinged', when: { phase: 'work' } } } },
      { id: 'pinged' },
    ],
  };
  const machine = createMachine(definition, { context: { phase: 'idle' } });
  const result = machine.send('GO');
  assert.deepEqual(result.context, { phase: 'work', tries: 1 });
  assert.deepEqual(result.active, ['job', 'work']);

  // 上一条转换写的值，下一条转换的 when 看得见
  assert.equal(machine.send('PING').matched, true);
  assert.deepEqual(machine.state().active, ['job', 'pinged']);
});

test('机器定义和事件名的问题各有各的码', () => {
  assert.equal(code(() => createMachine(null)), 'ERR_BAD_MACHINE');
  assert.equal(code(() => createMachine({ id: 'job', initial: 'a', states: [{ id: '' }] })),
    'ERR_BAD_MACHINE');
  assert.equal(code(() => createMachine({ id: 'job', initial: 'a', states: [{ id: 'a' }, { id: 'a' }] })),
    'ERR_BAD_MACHINE');
  assert.equal(code(() => createMachine({ id: 'job', initial: 'a', states: [] })),
    'ERR_BAD_MACHINE');
  assert.equal(code(() => createMachine({ id: 'job', initial: 'c', states: [{ id: 'a' }, { id: 'b' }] })),
    'ERR_BAD_MACHINE');
  assert.equal(code(() => createMachine({ id: 'job', initial: 'a', states: [{ id: 'a', initial: 'a' }] })),
    'ERR_BAD_MACHINE');
  assert.equal(code(() => createMachine({
    id: 'job',
    initial: 'a',
    states: [{ id: 'a', on: { GO: 'nope' } }],
  })), 'ERR_BAD_MACHINE');
  assert.equal(code(() => createMachine({
    id: 'job',
    initial: 'a',
    states: [{ id: 'a', on: { GO: { target: 'a', nope: 1 } } }],
  })), 'ERR_BAD_MACHINE');
  assert.equal(code(() => createMachine({
    id: 'job',
    initial: 'a',
    states: [{ id: 'a', history: true }],
  })), 'ERR_BAD_MACHINE');
  assert.equal(code(() => createMachine(job, { context: 3 })), 'ERR_BAD_MACHINE');

  const machine = createMachine(job);
  assert.equal(code(() => machine.send('')), 'ERR_BAD_EVENT');
  assert.equal(code(() => machine.send(7)), 'ERR_BAD_EVENT');
  assert.equal(code(() => machine.raise(null)), 'ERR_BAD_EVENT');
});
