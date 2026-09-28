import { createMachine, run, DEFAULTS } from '../lib/stateflow.js';

const job = {
  id: 'job',
  initial: 'idle',
  states: [
    { id: 'idle', on: { START: 'running' } },
    {
      id: 'running',
      initial: 'fast',
      history: true,
      states: [
        { id: 'fast', on: { SLOW: 'slow' } },
        { id: 'slow', on: { FAST: 'fast' } },
      ],
      on: { DONE: 'done', PAUSE: 'paused', RESTART: 'running' },
    },
    { id: 'paused', on: { RESUME: { target: 'running', viaHistory: true } } },
    { id: 'done', final: true },
  ],
};

const guarded = {
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

const queued = {
  id: 'job',
  initial: 'idle',
  states: [
    { id: 'idle', on: { GO: 'one' } },
    { id: 'one', on: { TICK: 'two' } },
    { id: 'two', on: { TOCK: 'done' } },
    { id: 'done', final: true },
  ],
};

const line = (label, value) => console.log(`  ${label} ${value}`);
const show = (label, result) => line(label,
  `active=${JSON.stringify(result.active)}`
  + ` trace=${result.trace.map((one) => `${one.type}:${one.state}`).join(' ')}`);

console.log('stateflow demo');
const machine = createMachine(job, { context: { retry: 0 } });
line('initial', JSON.stringify(machine.state().active));
show('START', machine.send('START'));
show('SLOW', machine.send('SLOW'));
show('PAUSE', machine.send('PAUSE'));
show('RESUME', machine.send('RESUME'));
show('RESTART', machine.send('RESTART'));
show('DONE', machine.send('DONE'));

const bulk = run(job, ['START', 'SLOW', 'DONE']);
line('run', `active=${JSON.stringify(bulk.active)} handled=${JSON.stringify(bulk.handled)}`);

const pick = (context) => {
  const one = createMachine(guarded, { context });
  one.send('GO');
  return one.state().active.join('/');
};
line('guard fast', pick({ fast: true }));
line('guard retry', pick({ retry: 2 }));
line('guard fallback', pick({}));

const queueMachine = createMachine(queued);
queueMachine.send('GO');
queueMachine.raise('TICK');
line('queued', JSON.stringify(queueMachine.send('TOCK').handled));
line('maxSteps', String(DEFAULTS.maxSteps));
