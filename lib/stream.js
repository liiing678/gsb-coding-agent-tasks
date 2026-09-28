// 事件时间窗口聚合。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/emit|late|state）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）和聚合算法（lib/agg.js）
// 都已经按 README 的《口径》和《API》两节写好了。那些约定不要改，把这里补出来。

export const DEFAULTS = {
  windowMs: 1000,          // 窗口宽度（必须 > 0）
  watermarkDelayMs: 0,     // 水位 = 见过最大的事件时间 - 这个值
  allowedLatenessMs: 0,    // 窗口到点之后再宽限多久才关
  retentionMs: 60000,      // 关掉的窗口还留多久
  aggregations: ['count'],
};

import {
  parseSpec,
  emptyAggregate,
  addValue,
  renderAggregate,
} from './agg.js';
import { AggError } from './errors.js';

const isPosInt = (value) => Number.isInteger(value) && value > 0;
const isNonNegInt = (value) => Number.isInteger(value) && value >= 0;
const compareKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const badConfig = (field, extra = {}) =>
  new AggError('ERR_BAD_CONFIG', `配置不合法：${field}`, { field, ...extra });

const badEvent = (field) =>
  new AggError('ERR_BAD_EVENT', `事件不合法：${field}`, { field });

export function createAggregator(config = {}) {
  const cfg = { ...DEFAULTS, ...config };

  if (!isPosInt(cfg.windowMs)) throw badConfig('windowMs');
  if (!isNonNegInt(cfg.watermarkDelayMs)) throw badConfig('watermarkDelayMs');
  if (!isNonNegInt(cfg.allowedLatenessMs)) throw badConfig('allowedLatenessMs');
  if (!isNonNegInt(cfg.retentionMs)) throw badConfig('retentionMs');
  if (!Array.isArray(cfg.aggregations) || cfg.aggregations.length === 0) {
    throw badConfig('aggregations');
  }

  const specs = [];
  for (const spec of cfg.aggregations) {
    const parsed = parseSpec(spec);
    if (parsed === null) throw badConfig('aggregations', { spec });
    specs.push({ spec, parsed });
  }

  const {
    windowMs,
    watermarkDelayMs: delayMs,
    allowedLatenessMs: latenessMs,
    retentionMs,
  } = cfg;

  // key -> (windowStart -> window)，两层 Map 避免拼 key 带来的碰撞。
  const byKey = new Map();
  let watermark = null;
  let maxEventTime = null;
  let seq = 0;
  let lateDropped = 0;

  function* eachWindow() {
    for (const byStart of byKey.values()) {
      for (const win of byStart.values()) yield win;
    }
  }

  const renderValues = (win) => {
    const values = {};
    specs.forEach(({ spec }, index) => {
      values[spec] = renderAggregate(win.aggregate[index]);
    });
    return values;
  };

  const emit = (win, state) => {
    seq += 1;
    return {
      seq,
      key: win.key,
      windowStart: win.start,
      windowEnd: win.end,
      state,
      values: renderValues(win),
    };
  };

  const publicView = (win) => ({
    key: win.key,
    windowStart: win.start,
    windowEnd: win.end,
    state: win.state,
    closedAt: win.closeAt,
    values: renderValues(win),
  });

  // 关掉的窗口留到 watermark >= closedAt + retentionMs 才整个放掉。
  const purgeExpired = () => {
    if (watermark === null) return;
    for (const [key, byStart] of byKey) {
      for (const [start, win] of byStart) {
        if (win.state === 'closed' && watermark >= win.closeAt + retentionMs) {
          byStart.delete(start);
        }
      }
      if (byStart.size === 0) byKey.delete(key);
    }
  };

  // 水位已经顶到 closeAt 的开窗口统一关掉，final 按 (windowEnd, key) 排，
  // 同一个 key 连着几个窗口时再用 windowStart 兜底，保证顺序确定。
  const closeDueWindows = () => {
    const due = [];
    for (const win of eachWindow()) {
      if (win.state === 'open' && watermark !== null && watermark >= win.closeAt) {
        due.push(win);
      }
    }
    due.sort(
      (a, b) =>
        a.end - b.end ||
        compareKey(a.key, b.key) ||
        a.start - b.start,
    );
    return due.map((win) => {
      win.state = 'closed';
      return emit(win, 'final');
    });
  };

  const validateEvent = (event) => {
    if (event === null || typeof event !== 'object') throw badEvent('event');
    if (typeof event.key !== 'string' || event.key === '') throw badEvent('key');
    if (!isNonNegInt(event.eventTime)) throw badEvent('eventTime');
    if (
      event.values === null ||
      typeof event.values !== 'object' ||
      Array.isArray(event.values)
    ) {
      throw badEvent('values');
    }
    const checked = new Set();
    for (const { parsed } of specs) {
      if (parsed.field === null || checked.has(parsed.field)) continue;
      checked.add(parsed.field);
      if (typeof event.values[parsed.field] !== 'number') {
        throw badEvent(`values.${parsed.field}`);
      }
    }
  };

  const openWindow = (key, start) => ({
    key,
    start,
    end: start + windowMs,
    closeAt: start + windowMs + latenessMs,
    state: 'open',
    aggregate: specs.map(({ parsed }) => emptyAggregate(parsed)),
  });

  function push(event) {
    // 1. 先校验，不合法直接抛，水位和窗口都不动。
    validateEvent(event);

    // 2. 水位只增不减：从见过的最大 eventTime 重算，小事件抬不动它。
    maxEventTime =
      maxEventTime === null
        ? event.eventTime
        : Math.max(maxEventTime, event.eventTime);
    const nextWatermark = maxEventTime - delayMs;
    if (watermark === null || nextWatermark > watermark) {
      watermark = nextWatermark;
    }

    purgeExpired();
    const emitted = closeDueWindows();

    // 3. 再看事件自己落在哪个窗口。
    const start = Math.floor(event.eventTime / windowMs) * windowMs;
    const closeAt = start + windowMs + latenessMs;

    let byStart = byKey.get(event.key);
    let win = byStart?.get(start);

    if (win === undefined) {
      // 窗口从没存在过，但它的 closeAt 已经过去：不补建，直接丢。
      if (watermark !== null && watermark >= closeAt) {
        lateDropped += 1;
        return { accepted: false, reason: 'too-late', emitted };
      }
      win = openWindow(event.key, start);
      if (!byStart) {
        byStart = new Map();
        byKey.set(event.key, byStart);
      }
      byStart.set(start, win);
    } else if (win.state === 'closed') {
      // 窗口已经关掉发过 final，迟到事件一概不受理。
      lateDropped += 1;
      return { accepted: false, reason: 'too-late', emitted };
    }

    specs.forEach(({ parsed }, index) => {
      const value = parsed.field === null ? undefined : event.values[parsed.field];
      win.aggregate[index] = addValue(win.aggregate[index], value);
    });
    emitted.push(emit(win, 'preliminary'));
    return { accepted: true, emitted };
  }

  function advanceTo(t) {
    if (!isNonNegInt(t)) throw badConfig('advanceTo');
    if (watermark !== null && t <= watermark) return { emitted: [] };
    watermark = t;
    purgeExpired();
    return { emitted: closeDueWindows() };
  }

  function flush() {
    const open = [];
    for (const win of eachWindow()) {
      if (win.state === 'open') open.push(win);
    }
    open.sort(
      (a, b) =>
        a.end - b.end ||
        compareKey(a.key, b.key) ||
        a.start - b.start,
    );
    const emitted = open.map((win) => {
      win.state = 'closed';
      return emit(win, 'final');
    });
    purgeExpired();
    return { emitted };
  }

  function stats() {
    let windows = 0;
    let openWindows = 0;
    let closedWindows = 0;
    for (const win of eachWindow()) {
      windows += 1;
      if (win.state === 'open') openWindows += 1;
      else closedWindows += 1;
    }
    return {
      watermark: watermark ?? 0,
      maxEventTime: maxEventTime ?? 0,
      windows,
      openWindows,
      closedWindows,
      emitted: seq,
      lateDropped,
    };
  }

  function windows() {
    return [...eachWindow()]
      .map(publicView)
      .sort(
        (a, b) =>
          a.windowStart - b.windowStart ||
          compareKey(a.key, b.key),
      );
  }

  function get(key, windowStart) {
    const win = byKey.get(key)?.get(windowStart);
    return win === undefined ? null : publicView(win);
  }

  return { push, advanceTo, flush, stats, windows, get };
}
