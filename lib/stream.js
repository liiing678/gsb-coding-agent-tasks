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

import { AggError } from './errors.js';
import {
  parseSpec,
  fieldsOf,
  emptyAggregate,
  addValue,
  renderAggregate,
} from './agg.js';

const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

const byWindowEndThenKey = (a, b) =>
  a.windowEnd - b.windowEnd || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const byWindowStartThenKey = (a, b) =>
  a.windowStart - b.windowStart || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export function createAggregator(config = {}) {
  const cfg = { ...DEFAULTS, ...config };

  if (!Number.isInteger(cfg.windowMs) || cfg.windowMs <= 0) {
    throw new AggError('ERR_BAD_CONFIG', 'windowMs 必须是正整数', { field: 'windowMs' });
  }
  for (const field of ['watermarkDelayMs', 'allowedLatenessMs', 'retentionMs']) {
    if (!isNonNegativeInteger(cfg[field])) {
      throw new AggError('ERR_BAD_CONFIG', `${field} 必须是非负整数`, { field });
    }
  }
  if (!Array.isArray(cfg.aggregations) || cfg.aggregations.length === 0) {
    throw new AggError('ERR_BAD_CONFIG', 'aggregations 必须是非空数组', { field: 'aggregations' });
  }
  const specs = cfg.aggregations.map((spec) => {
    const parsed = parseSpec(spec);
    if (parsed === null) {
      throw new AggError('ERR_BAD_CONFIG', `不认识的聚合项: ${spec}`, {
        field: 'aggregations',
        spec,
      });
    }
    return { spec, parsed };
  });
  const requiredFields = [...new Set(specs.flatMap((entry) => fieldsOf(entry.parsed)))];

  // 窗口本体按 (key, windowStart) 存；关掉的留着，过了保留期再整个删掉。
  const windows = new Map();
  const windowId = (key, windowStart) => `${key}\n${windowStart}`;

  let maxEventTime = 0;
  let watermark = -cfg.watermarkDelayMs;
  let seq = 0;
  let lateDropped = 0;

  const renderValues = (win) => {
    const values = {};
    specs.forEach((entry, index) => {
      values[entry.spec] = renderAggregate(win.aggregates[index]);
    });
    return values;
  };

  const emit = (win, state) => {
    seq += 1;
    return {
      seq,
      key: win.key,
      windowStart: win.windowStart,
      windowEnd: win.windowEnd,
      state,
      values: renderValues(win),
    };
  };

  // 水位 >= closeAt 的窗口关掉发 final，按 (windowEnd, key) 排。
  const closeDue = () => {
    const due = [...windows.values()]
      .filter((win) => win.state === 'open' && win.closeAt <= watermark)
      .sort(byWindowEndThenKey);
    return due.map((win) => {
      win.state = 'closed';
      win.closedAt = watermark;
      return emit(win, 'final');
    });
  };

  // 关掉的窗口过了保留期就放掉。
  const cleanup = () => {
    for (const [id, win] of windows) {
      if (win.state === 'closed' && watermark >= win.closedAt + cfg.retentionMs) {
        windows.delete(id);
      }
    }
  };

  const validateEvent = (event) => {
    if (event === null || typeof event !== 'object') {
      throw new AggError('ERR_BAD_EVENT', '事件必须是对象', { field: 'event' });
    }
    if (typeof event.key !== 'string' || event.key.length === 0) {
      throw new AggError('ERR_BAD_EVENT', 'key 必须是非空字符串', { field: 'key' });
    }
    if (!isNonNegativeInteger(event.eventTime)) {
      throw new AggError('ERR_BAD_EVENT', 'eventTime 必须是非负整数', { field: 'eventTime' });
    }
    if (event.values === null || typeof event.values !== 'object' || Array.isArray(event.values)) {
      throw new AggError('ERR_BAD_EVENT', 'values 必须是对象', { field: 'values' });
    }
    for (const field of requiredFields) {
      const value = event.values[field];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new AggError('ERR_BAD_EVENT', `values.${field} 必须是数字`, {
          field: `values.${field}`,
        });
      }
    }
  };

  const push = (event) => {
    validateEvent(event);

    // 先推水位、关到期窗口；水位只增不减。
    if (event.eventTime > maxEventTime) {
      maxEventTime = event.eventTime;
      watermark = Math.max(watermark, maxEventTime - cfg.watermarkDelayMs);
    }
    const emitted = closeDue();
    cleanup();

    // 再看事件自己落在哪儿。
    const windowStart = Math.floor(event.eventTime / cfg.windowMs) * cfg.windowMs;
    const id = windowId(event.key, windowStart);
    let win = windows.get(id);
    if (win !== undefined && win.state === 'closed') {
      lateDropped += 1;
      return { accepted: false, reason: 'too-late', emitted };
    }
    if (win === undefined) {
      const windowEnd = windowStart + cfg.windowMs;
      const closeAt = windowEnd + cfg.allowedLatenessMs;
      if (closeAt <= watermark) {
        lateDropped += 1;
        return { accepted: false, reason: 'too-late', emitted };
      }
      win = {
        key: event.key,
        windowStart,
        windowEnd,
        closeAt,
        state: 'open',
        closedAt: null,
        aggregates: specs.map((entry) => emptyAggregate(entry.parsed)),
      };
      windows.set(id, win);
    }
    specs.forEach((entry, index) => {
      win.aggregates[index] = addValue(
        win.aggregates[index],
        entry.parsed.field === null ? undefined : event.values[entry.parsed.field],
      );
    });
    emitted.push(emit(win, 'preliminary'));
    return { accepted: true, emitted };
  };

  const advanceTo = (t) => {
    if (!isNonNegativeInteger(t)) {
      throw new AggError('ERR_BAD_CONFIG', 'advanceTo 需要非负整数', { field: 'advanceTo' });
    }
    if (t > watermark) {
      watermark = t;
    }
    const emitted = closeDue();
    cleanup();
    return { emitted };
  };

  const flush = () => {
    const open = [...windows.values()]
      .filter((win) => win.state === 'open')
      .sort(byWindowEndThenKey);
    const emitted = open.map((win) => {
      win.state = 'closed';
      win.closedAt = watermark;
      return emit(win, 'final');
    });
    cleanup();
    return { emitted };
  };

  const toPublic = (win) => ({
    key: win.key,
    windowStart: win.windowStart,
    windowEnd: win.windowEnd,
    state: win.state,
    closedAt: win.closedAt,
    values: renderValues(win),
  });

  const get = (key, windowStart) => {
    const win = windows.get(windowId(key, windowStart));
    return win === undefined ? null : toPublic(win);
  };

  const list = () =>
    [...windows.values()].sort(byWindowStartThenKey).map(toPublic);

  const stats = () => {
    let openWindows = 0;
    for (const win of windows.values()) {
      if (win.state === 'open') openWindows += 1;
    }
    return {
      watermark,
      maxEventTime,
      windows: windows.size,
      openWindows,
      closedWindows: windows.size - openWindows,
      emitted: seq,
      lateDropped,
    };
  };

  return { push, advanceTo, flush, stats, windows: list, get };
}
