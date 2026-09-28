// 点版本向量内核：时钟的规范化、比较、合并、缺哪些 dot，以及因果投递节点。
// 一切跟「点」有关的判断都按真正的点集算，时钟允许带洞，不能拿某个 id 的顶当点集。

import { VclockError } from './errors.js';

const badClock = (message) => new VclockError('ERR_BAD_CLOCK', message);
const badDot = (message) => new VclockError('ERR_BAD_DOT', message);
const badMessage = (message) => new VclockError('ERR_BAD_MESSAGE', message);

const isNonEmptyString = (value) => typeof value === 'string' && value !== '';
const isPosInt = (value) => Number.isInteger(value) && value >= 1;
const dotKey = (dot) => `${dot.id}\u0000${dot.counter}`;

// 要求收到的是已经规范化的时钟：段数组、按 id 升序、同 id 内相邻段已合并、允许有洞。
function assertClock(clock) {
  if (!Array.isArray(clock)) throw badClock('时钟必须是段数组');
  let prevId = '';
  let prevTo = 0;
  for (const seg of clock) {
    if (seg === null || typeof seg !== 'object' || Array.isArray(seg)) {
      throw badClock('时钟的每一段必须是 { id, from, to }');
    }
    const { id, from, to } = seg;
    if (!isNonEmptyString(id)) throw badClock('段的 id 必须是非空字符串');
    if (!isPosInt(from) || !isPosInt(to) || from > to) {
      throw badClock('段的 from/to 必须是满足 1 <= from <= to 的整数');
    }
    if (id < prevId) throw badClock('各段必须按 id 升序排列');
    if (id === prevId && from <= prevTo + 1) {
      throw badClock('同一个 id 上相邻或重叠的两段必须并成一段');
    }
    prevId = id;
    prevTo = to;
  }
}

const cloneClock = (clock) => clock.map((seg) => ({ id: seg.id, from: seg.from, to: seg.to }));

export function empty() {
  return [];
}

export function tick(clock, id) {
  assertClock(clock);
  if (!isNonEmptyString(id)) throw badClock('tick 的 id 必须是非空字符串');
  let lastIndex = -1;
  for (let i = 0; i < clock.length; i += 1) {
    if (clock[i].id === id) lastIndex = i;
  }
  if (lastIndex === -1) {
    return merge(clock, [{ id, from: 1, to: 1 }]);
  }
  const next = cloneClock(clock);
  next[lastIndex].to += 1;
  return next;
}

// 点的并集（不是计数相加），再规范化：排序并合并同 id 上相邻或重叠的段，洞保留。
export function merge(...clocks) {
  for (const clock of clocks) assertClock(clock);
  const segments = clocks.flatMap(cloneClock);
  segments.sort((left, right) => {
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return left.from - right.from;
  });
  const result = [];
  for (const seg of segments) {
    const last = result[result.length - 1];
    if (last && last.id === seg.id && seg.from <= last.to + 1) {
      last.to = Math.max(last.to, seg.to);
    } else {
      result.push({ ...seg });
    }
  }
  return result;
}

export function compare(left, right) {
  assertClock(left);
  assertClock(right);
  const leftDots = new Set(dots(left).map(dotKey));
  const rightDots = new Set(dots(right).map(dotKey));
  let leftOnly = false;
  let rightOnly = false;
  for (const key of leftDots) {
    if (!rightDots.has(key)) leftOnly = true;
  }
  for (const key of rightDots) {
    if (!leftDots.has(key)) rightOnly = true;
  }
  if (leftOnly && rightOnly) return 'concurrent';
  if (leftOnly) return 'after';
  if (rightOnly) return 'before';
  return 'equal';
}

export function dots(clock) {
  assertClock(clock);
  const result = [];
  for (const seg of clock) {
    for (let counter = seg.from; counter <= seg.to; counter += 1) {
      result.push({ id: seg.id, counter });
    }
  }
  return result;
}

export function contains(clock, dot) {
  assertClock(clock);
  if (dot === null || typeof dot !== 'object' || Array.isArray(dot)
    || !isNonEmptyString(dot.id) || !isPosInt(dot.counter)) {
    throw badDot('dot 必须是 { id: 非空字符串, counter: 正整数 }');
  }
  return clock.some(
    (seg) => seg.id === dot.id && dot.counter >= seg.from && dot.counter <= seg.to,
  );
}

export function missing(clock, other) {
  assertClock(clock);
  assertClock(other);
  return dots(other)
    .filter((dot) => !contains(clock, dot))
    .map((dot) => `${dot.id}:${dot.counter}`);
}

function assertMessage(message) {
  const fail = () => { throw badMessage('消息必须是 { from: 非空字符串, payload, clock }'); };
  if (message === null || typeof message !== 'object' || Array.isArray(message)) fail();
  if (!isNonEmptyString(message.from)) fail();
  if (!Object.prototype.hasOwnProperty.call(message, 'payload')) fail();
  try {
    assertClock(message.clock);
  } catch {
    fail();
  }
  if (!message.clock.some((seg) => seg.id === message.from)) fail();
}

// 消息自己的点：from 的顶（该 id 最后一段的 to）。
const ownDotOf = (message) => {
  let top = 0;
  for (const seg of message.clock) {
    if (seg.id === message.from && seg.to > top) top = seg.to;
  }
  return { id: message.from, counter: top };
};

export function createNode(id) {
  if (!isNonEmptyString(id)) throw badClock('节点 id 必须是非空字符串');
  let clock = empty();
  const held = [];

  // 前置齐不齐：消息 clock 的点除了它自己那个点，其余都得已经在本节点时钟里。
  const prereqsMet = (message) => {
    const own = ownDotOf(message);
    return dots(message.clock).every(
      (dot) => (dot.id === own.id && dot.counter === own.counter) || contains(clock, dot),
    );
  };

  const drain = () => {
    let changed = true;
    while (changed) {
      changed = false;
      const remaining = [];
      for (const message of held) {
        if (prereqsMet(message)) {
          clock = merge(clock, message.clock);
          changed = true;
        } else {
          remaining.push(message);
        }
      }
      held.length = 0;
      held.push(...remaining);
    }
  };

  return {
    id,
    clock: () => cloneClock(clock),
    pending: () => held.map((message) => ({
      from: message.from,
      payload: message.payload,
      clock: cloneClock(message.clock),
    })),
    send(payload) {
      clock = tick(clock, id);
      return { from: id, payload, clock: cloneClock(clock) };
    },
    deliver(message) {
      assertMessage(message);
      const own = ownDotOf(message);
      if (contains(clock, own)) return false;
      if (held.some((heldMessage) => {
        const heldOwn = ownDotOf(heldMessage);
        return heldOwn.id === own.id && heldOwn.counter === own.counter;
      })) {
        return false;
      }
      if (!prereqsMet(message)) {
        held.push(message);
        return false;
      }
      clock = merge(clock, message.clock);
      drain();
      return true;
    },
  };
}
