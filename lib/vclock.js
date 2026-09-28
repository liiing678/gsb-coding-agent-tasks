import { VclockError } from './errors.js';

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isPositiveInteger = (value) => Number.isInteger(value) && value >= 1;
const cloneSegment = (segment) => ({ id: segment.id, from: segment.from, to: segment.to });

function badClock() {
  throw new VclockError('ERR_BAD_CLOCK', 'clock is not normalized');
}

function assertId(id) {
  if (!isNonEmptyString(id)) {
    throw new VclockError('ERR_BAD_CLOCK', 'id must be a non-empty string');
  }
}

function assertClock(clock) {
  if (!Array.isArray(clock)) {
    badClock();
  }

  let previousId;
  let previousTo;

  for (const segment of clock) {
    if (typeof segment !== 'object' || segment === null || Array.isArray(segment)) {
      badClock();
    }
    if (!isNonEmptyString(segment.id) ||
        !isPositiveInteger(segment.from) ||
        !isPositiveInteger(segment.to) ||
        segment.from > segment.to) {
      badClock();
    }

    if (previousId === undefined) {
      previousId = segment.id;
      previousTo = segment.to;
    } else if (segment.id === previousId) {
      if (segment.from <= previousTo + 1) {
        badClock();
      }
      previousTo = segment.to;
    } else {
      if (segment.id < previousId) {
        badClock();
      }
      previousId = segment.id;
      previousTo = segment.to;
    }
  }
}

function unionClocks(clocks) {
  const groups = new Map();

  for (const clock of clocks) {
    for (const segment of clock) {
      if (!groups.has(segment.id)) {
        groups.set(segment.id, []);
      }
      groups.get(segment.id).push({ from: segment.from, to: segment.to });
    }
  }

  const result = [];
  const ids = [...groups.keys()].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0);

  for (const id of ids) {
    const ranges = groups.get(id).sort((left, right) => left.from - right.from);
    let current = { ...ranges[0] };

    for (let index = 1; index < ranges.length; index += 1) {
      const range = ranges[index];
      if (range.from <= current.to + 1) {
        current.to = Math.max(current.to, range.to);
      } else {
        result.push({ id, from: current.from, to: current.to });
        current = { ...range };
      }
    }
    result.push({ id, from: current.from, to: current.to });
  }

  return result;
}

function hasDot(clock, id, counter) {
  return clock.some((segment) =>
    segment.id === id && segment.from <= counter && counter <= segment.to);
}

function covers(container, target) {
  const groups = new Map();
  for (const segment of container) {
    if (!groups.has(segment.id)) {
      groups.set(segment.id, []);
    }
    groups.get(segment.id).push(segment);
  }

  for (const wanted of target) {
    const ranges = groups.get(wanted.id);
    if (!ranges) {
      return false;
    }

    let coveredThrough = wanted.from - 1;
    for (const range of ranges) {
      if (range.to <= coveredThrough) {
        continue;
      }
      if (range.from > coveredThrough + 1) {
        return false;
      }
      coveredThrough = range.to;
      if (coveredThrough >= wanted.to) {
        break;
      }
    }

    if (coveredThrough < wanted.to) {
      return false;
    }
  }

  return true;
}

function assertDot(dot) {
  if (typeof dot !== 'object' || dot === null || Array.isArray(dot) ||
      !isNonEmptyString(dot.id) || !isPositiveInteger(dot.counter)) {
    throw new VclockError('ERR_BAD_DOT', 'dot must be { id, counter }');
  }
}

function topCounter(clock, id) {
  let top;
  for (const segment of clock) {
    if (segment.id === id) {
      top = segment.to;
    }
  }
  return top;
}

function assertMessage(message) {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    throw new VclockError('ERR_BAD_MESSAGE', 'message must be an object');
  }
  if (!isNonEmptyString(message.from)) {
    throw new VclockError('ERR_BAD_MESSAGE', 'message.from must be a non-empty string');
  }
  if (!Object.hasOwn(message, 'payload')) {
    throw new VclockError('ERR_BAD_MESSAGE', 'message.payload is required');
  }

  try {
    assertClock(message.clock);
  } catch {
    throw new VclockError('ERR_BAD_MESSAGE', 'message.clock must be a normalized clock');
  }

  if (topCounter(message.clock, message.from) === undefined) {
    throw new VclockError('ERR_BAD_MESSAGE', 'message.clock must contain a dot from its sender');
  }
}

function prerequisitesReady(clock, message, selfCounter) {
  for (const segment of message.clock) {
    for (let counter = segment.from; counter <= segment.to; counter += 1) {
      if (segment.id === message.from && counter === selfCounter) {
        continue;
      }
      if (!hasDot(clock, segment.id, counter)) {
        return false;
      }
    }
  }
  return true;
}

function copyMessage(message) {
  return {
    from: message.from,
    payload: message.payload,
    clock: message.clock.map(cloneSegment),
  };
}

export function empty() {
  return [];
}

export function tick(clock, id) {
  assertClock(clock);
  assertId(id);

  const next = clock.map(cloneSegment);
  let index = -1;
  for (let cursor = next.length - 1; cursor >= 0; cursor -= 1) {
    if (next[cursor].id === id) {
      index = cursor;
      break;
    }
  }

  if (index === -1) {
    const insertAt = next.findIndex((segment) => segment.id > id);
    const segment = { id, from: 1, to: 1 };
    if (insertAt === -1) {
      next.push(segment);
    } else {
      next.splice(insertAt, 0, segment);
    }
  } else {
    next[index].to += 1;
  }

  return next;
}

export function merge(...clocks) {
  clocks.forEach(assertClock);
  return unionClocks(clocks);
}

export function compare(left, right) {
  assertClock(left);
  assertClock(right);

  const leftCoversRight = covers(left, right);
  const rightCoversLeft = covers(right, left);

  if (leftCoversRight && rightCoversLeft) {
    return 'equal';
  }
  if (rightCoversLeft) {
    return 'before';
  }
  if (leftCoversRight) {
    return 'after';
  }
  return 'concurrent';
}

export function dots(clock) {
  assertClock(clock);

  const result = [];
  for (const segment of clock) {
    for (let counter = segment.from; counter <= segment.to; counter += 1) {
      result.push({ id: segment.id, counter });
    }
  }
  return result;
}

export function contains(clock, dot) {
  assertClock(clock);
  assertDot(dot);
  return hasDot(clock, dot.id, dot.counter);
}

export function missing(clock, other) {
  assertClock(clock);
  assertClock(other);

  return dots(other)
    .filter((dot) => !hasDot(clock, dot.id, dot.counter))
    .map((dot) => `${dot.id}:${dot.counter}`);
}

export function createNode(id) {
  assertId(id);

  let clock = empty();
  let pending = [];

  function drainPending() {
    let changed = true;
    while (changed) {
      changed = false;

      for (let index = 0; index < pending.length; index += 1) {
        const message = pending[index];
        const selfCounter = topCounter(message.clock, message.from);

        if (prerequisitesReady(clock, message, selfCounter)) {
          clock = merge(clock, message.clock);
          pending.splice(index, 1);
          changed = true;
          break;
        }
      }
    }
  }

  return {
    id,
    clock: () => clock.map(cloneSegment),
    pending: () => pending.map(copyMessage),
    send(payload) {
      clock = tick(clock, id);
      return {
        from: id,
        payload,
        clock: clock.map(cloneSegment),
      };
    },
    deliver(message) {
      assertMessage(message);

      const selfCounter = topCounter(message.clock, message.from);
      if (hasDot(clock, message.from, selfCounter) ||
          pending.some((held) =>
            held.from === message.from && topCounter(held.clock, held.from) === selfCounter)) {
        return false;
      }

      if (!prerequisitesReady(clock, message, selfCounter)) {
        pending.push(copyMessage(message));
        return false;
      }

      clock = merge(clock, message.clock);
      drainPending();
      return true;
    },
  };
}
