// 重复日程展开。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/rules|dst|overrides）、演示脚本
// （scripts/demo.mjs）、规则解析（lib/ics.js）、时区换算（lib/tz.js）和错误码
// （lib/errors.js）都已经按 README 的《口径》和《API》两节写好了。
// 那些约定不要改，把这里补出来。
import { CalError } from './errors.js';
import { parseRule, parseWall, WEEKDAYS } from './ics.js';
import { isZone, isoZ, localToUtc, wallMsOf, wallPartsOf, wallText } from './tz.js';

export const DEFAULTS = {
  limit: 1000,          // 结果条数上限
  maxIterations: 100000, // 内部周期数上限
};

const DAY = 86400000;

function badSeries(message, details) {
  throw new CalError('ERR_BAD_SERIES', message, details);
}

function asList(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) badSeries(`${name} 要是数组`, { value });
  return value;
}

function checkDuration(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    badSeries(`${name} 要是不小于 0 的分钟数：${value}`, { value });
  }
  return value;
}

// from / to：UTC 时刻，...Z（或带偏移）字符串或毫秒数
function parseInstant(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(value)
  ) {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  badSeries(`${name} 要是 UTC 时刻（...Z 字符串或毫秒数）：${value}`, { value });
}

function checkPositiveInt(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    badSeries(`${name} 要是正整数：${value}`, { value });
  }
  return value;
}

const weekdayOf = (dayWall) => new Date(dayWall).getUTCDay();

// y 年 mo 月（1 起）有多少天
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

function addMonths(y, mo, delta) {
  const total = y * 12 + (mo - 1) + delta;
  return { y: Math.floor(total / 12), mo: (total % 12) + 1 };
}

// 一个月里规则命中的日子（1 起，升序）。BYSETPOS 不在这里取，由调用方按周期取。
function monthDays(y, mo, rule, startDay) {
  const dim = daysInMonth(y, mo);
  let days = [];
  if (rule.byMonthDay.length > 0) {
    for (const n of rule.byMonthDay) {
      const d = n > 0 ? n : dim + n + 1;
      if (d >= 1 && d <= dim) days.push(d); // 没有这一天的月份直接跳过，不顺延
    }
  } else if (rule.byDay.length > 0) {
    if (rule.byDay[0].ordinal !== null) {
      const firstWeekday = weekdayOf(Date.UTC(y, mo - 1, 1));
      const lastWeekday = weekdayOf(Date.UTC(y, mo - 1, dim));
      for (const { ordinal, weekday } of rule.byDay) {
        if (ordinal > 0) {
          const d = 1 + ((weekday - firstWeekday + 7) % 7) + (ordinal - 1) * 7;
          if (d <= dim) days.push(d);
        } else {
          const d = dim - ((lastWeekday - weekday + 7) % 7) + (ordinal + 1) * 7;
          if (d >= 1) days.push(d);
        }
      }
    } else {
      const set = new Set(rule.byDay.map((d) => d.weekday));
      for (let d = 1; d <= dim; d++) {
        if (set.has(weekdayOf(Date.UTC(y, mo - 1, d)))) days.push(d);
      }
    }
  } else if (startDay <= dim) {
    days.push(startDay);
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

// BYSETPOS：对一个周期排好序的候选列表取第 n 个，负数是倒数
function applySetPos(list, positions) {
  const picked = [];
  for (const p of positions) {
    const idx = p > 0 ? p - 1 : list.length + p;
    if (idx >= 0 && idx < list.length) picked.push(list[idx]);
  }
  return [...new Set(picked)].sort((a, b) => a - b);
}

// 按规则在本地日历上推出发生墙钟（毫秒，墙钟当作 UTC 轴）。COUNT / UNTIL 在这里生效。
function generateOccurrences(tz, rule, startWall, untilWall, toMs, coverWall, maxIterations) {
  const startParts = wallPartsOf(startWall);
  const todMs = startParts.h * 3600000 + startParts.mi * 60000 + startParts.s * 1000;
  const startDayWall = startWall - todMs;

  const occurrences = [];
  let iterations = 0;
  const tick = () => {
    iterations++;
    if (iterations > maxIterations) {
      throw new CalError('ERR_LIMIT_EXCEEDED', `展开停不下来：周期数超过 maxIterations=${maxIterations}`, {
        maxIterations,
      });
    }
  };

  // 返回 false 表示后面的候选都不可能再要，整个展开收工
  const emit = (dayWall) => {
    tick();
    const wall = dayWall + todMs;
    if (wall < startWall) return true; // DTSTART 之前的丢掉，也不占 COUNT 名额
    if (untilWall !== null && wall > untilWall) return false; // UNTIL 含边界
    if (toMs !== null && wall > coverWall && localToUtc(tz, wall).instant > toMs) return false;
    if (rule.count !== null && occurrences.length >= rule.count) return false;
    occurrences.push({ wall, text: wallText(wall) });
    return true;
  };

  if (rule.freq === 'DAILY') {
    const weekdays = rule.byDay.length > 0 ? new Set(rule.byDay.map((d) => d.weekday)) : null;
    for (let i = 0; ; i += rule.interval) {
      tick();
      const dayWall = startDayWall + i * DAY;
      const p = wallPartsOf(dayWall);
      if (rule.byMonth.length > 0 && !rule.byMonth.includes(p.mo)) continue;
      if (weekdays !== null && !weekdays.has(weekdayOf(dayWall))) continue;
      if (
        rule.byMonthDay.length > 0 &&
        !rule.byMonthDay.some((n) => (n > 0 ? n === p.d : daysInMonth(p.y, p.mo) + n + 1 === p.d))
      ) {
        continue;
      }
      if (!emit(dayWall)) break;
    }
  } else if (rule.freq === 'WEEKLY') {
    const wkst = WEEKDAYS[rule.wkst];
    const startWeekday = weekdayOf(startDayWall);
    const weekBegin = startDayWall - ((startWeekday - wkst + 7) % 7) * DAY;
    const days = rule.byDay.length > 0 ? rule.byDay.map((d) => d.weekday) : [startWeekday];
    const offsets = [...new Set(days.map((wd) => (wd - wkst + 7) % 7))].sort((a, b) => a - b);
    for (let w = 0; ; w += rule.interval) {
      tick();
      const base = weekBegin + w * 7 * DAY;
      let goOn = true;
      for (const off of offsets) {
        if (!emit(base + off * DAY)) {
          goOn = false;
          break;
        }
      }
      if (!goOn) break;
    }
  } else if (rule.freq === 'MONTHLY') {
    for (let m = 0; ; m += rule.interval) {
      tick();
      const { y, mo } = addMonths(startParts.y, startParts.mo, m);
      if (rule.byMonth.length > 0 && !rule.byMonth.includes(mo)) continue;
      let days = monthDays(y, mo, rule, startParts.d);
      if (rule.bySetPos.length > 0) days = applySetPos(days, rule.bySetPos);
      let goOn = true;
      for (const d of days) {
        if (!emit(wallMsOf({ y, mo, d, h: 0, mi: 0, s: 0 }))) {
          goOn = false;
          break;
        }
      }
      if (!goOn) break;
    }
  } else {
    // YEARLY：BYSETPOS 对一整年的候选取
    for (let yi = 0; ; yi += rule.interval) {
      tick();
      const y = startParts.y + yi;
      const months = rule.byMonth.length > 0 ? [...rule.byMonth].sort((a, b) => a - b) : [startParts.mo];
      let cands = [];
      for (const mo of months) {
        for (const d of monthDays(y, mo, rule, startParts.d)) cands.push(mo * 100 + d);
      }
      cands.sort((a, b) => a - b);
      if (rule.bySetPos.length > 0) cands = applySetPos(cands, rule.bySetPos);
      let goOn = true;
      for (const c of cands) {
        const mo = Math.floor(c / 100);
        const d = c % 100;
        if (!emit(wallMsOf({ y, mo, d, h: 0, mi: 0, s: 0 }))) {
          goOn = false;
          break;
        }
      }
      if (!goOn) break;
    }
  }
  return occurrences;
}

export function expandSeries(series = {}, options = {}) {
  if (series === null || typeof series !== 'object') badSeries('series 要是对象', { series });

  const tz = series.tz === undefined || series.tz === null ? 'UTC' : String(series.tz);
  if (!isZone(tz)) {
    throw new CalError('ERR_BAD_TZ', `时区不认识：${series.tz}`, { tz: series.tz });
  }

  const startParsed = parseWall(series.start);
  const startWall = startParsed.wall;
  const duration = checkDuration(series.duration, 'duration');
  const rule = parseRule(series.rule);

  const exdates = new Set(asList(series.exdates, 'exdates').map((v) => parseWall(v).text));
  const rdates = asList(series.rdates, 'rdates').map((v) => parseWall(v));
  const overrides = asList(series.overrides, 'overrides').map((o) => {
    if (o === null || typeof o !== 'object') badSeries('override 要是对象', { override: o });
    const at = parseWall(o.at);
    let newStart = null;
    if (o.start !== undefined && o.start !== null) newStart = parseWall(o.start).wall;
    let newDuration = null;
    if (o.duration !== undefined && o.duration !== null) newDuration = checkDuration(o.duration, 'override.duration');
    return { atText: at.text, atWall: at.wall, start: newStart, duration: newDuration, cancelled: o.cancelled === true };
  });

  const fromMs = parseInstant(options.from, 'from');
  const toMs = parseInstant(options.to, 'to');
  const limit = checkPositiveInt(options.limit ?? DEFAULTS.limit, 'limit');
  const maxIterations = checkPositiveInt(options.maxIterations ?? DEFAULTS.maxIterations, 'maxIterations');

  const untilWall = rule.until === null ? null : parseWall(rule.until).wall;
  // 窗口提前收工之前，得先把 override 的 at 都覆盖到，不然会误判 ERR_BAD_OVERRIDE
  const coverWall = overrides.reduce((max, o) => Math.max(max, o.atWall), -Infinity);

  const occurrences = generateOccurrences(tz, rule, startWall, untilWall, toMs, coverWall, maxIterations);

  const overrideMap = new Map();
  for (const o of overrides) overrideMap.set(o.atText, o);

  const known = new Set(occurrences.map((o) => o.text));
  for (const r of rdates) known.add(r.text);
  for (const o of overrides) {
    if (!known.has(o.atText)) {
      throw new CalError('ERR_BAD_OVERRIDE', `override 对不上任何一次发生：${o.atText}`, { at: o.atText });
    }
  }

  const items = [];
  const collect = (wall, text) => {
    const ov = overrideMap.get(text);
    if (ov) {
      // 同一次同时被 EXDATE 和 override 命中时，先看 override
      if (ov.cancelled) return;
      items.push({
        recurrenceId: text,
        wall: ov.start ?? wall,
        duration: ov.duration ?? duration,
        modified: true,
      });
    } else if (!exdates.has(text)) {
      items.push({ recurrenceId: text, wall, duration, modified: false });
    }
  };
  for (const occ of occurrences) collect(occ.wall, occ.text);
  for (const r of rdates) collect(r.wall, r.text);

  const rows = items.map((item) => {
    const startConv = localToUtc(tz, item.wall);
    const endConv = localToUtc(tz, item.wall + item.duration * 60000);
    const text = wallText(item.wall);
    return {
      recurrenceId: item.recurrenceId,
      startMs: startConv.instant,
      endMs: endConv.instant,
      localDate: text.slice(0, 10),
      localTime: text.slice(11),
      offsetMinutes: startConv.offsetMinutes,
      kind: startConv.kind,
      modified: item.modified,
    };
  });
  rows.sort(
    (a, b) =>
      a.startMs - b.startMs ||
      (a.recurrenceId < b.recurrenceId ? -1 : a.recurrenceId > b.recurrenceId ? 1 : 0),
  );

  const windowed = rows.filter(
    (r) => (fromMs === null || r.startMs >= fromMs) && (toMs === null || r.startMs <= toMs),
  );
  if (windowed.length > limit) {
    throw new CalError('ERR_LIMIT_EXCEEDED', `结果 ${windowed.length} 条，超过 limit=${limit}`, {
      limit,
      count: windowed.length,
    });
  }

  return windowed.map((r, i) => ({
    recurrenceId: r.recurrenceId,
    sequence: i + 1,
    start: isoZ(r.startMs),
    end: isoZ(r.endMs),
    localDate: r.localDate,
    localTime: r.localTime,
    offsetMinutes: r.offsetMinutes,
    kind: r.kind,
    modified: r.modified,
  }));
}
