export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

export const shown = (trace) => trace.map((entry) => `${entry.type}:${entry.state}`);

export const job = {
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
