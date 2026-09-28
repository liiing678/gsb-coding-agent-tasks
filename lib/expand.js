// 重复日程展开：在本地日历上一天一天 / 一周一周 / 一月一月地推墙钟，
// 推完再换算成 UTC 时刻。夏令时三档（exact / gap / ambiguous）由 tz.js 的
// localToUtc 判定，这里只负责把墙钟喂给它。
import { CalError } from './errors.js';
import { parseRule, parseWall, WEEKDAYS } from './ics.js';
import { isZone, isoZ, localToUtc, wallPartsOf, wallText } from './tz.js';

export const DEFAULTS = {
  limit: 1000,          // 结果条数上限
  maxIterations: 100000, // 内部周期数上限
};

const DAY_MS = 86400000;
const MAX_OFFSET_MIN = 14 * 60; // 任何时区的偏移都不超过 +14h，用来给窗口收尾兜底

// “日序号”：把墙钟日期当成 UTC 日期取天数，日历推算全在这个整数轴上做
const serialOf = (y, mo, d) => Date.UTC(y, mo - 1, d) / DAY_MS;
const weekdayOfSerial = (serial) => new Date(serial * DAY_MS).getUTCDay();
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

function badSeries(message, details) {
  throw new CalError('ERR_BAD_SERIES', message, details);
}

function listOf(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) badSeries(`${name} 要是数组`, { [name]: value });
  return value;
}

// options.from / options.to：...Z 字符串或毫秒数
function parseBound(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  badSeries(`${name} 要是 ...Z 字符串或毫秒数：${value}`, { [name]: value });
}

// 一个月内的候选日：BYMONTHDAY（负数从月底数）、BYDAY（带序数或不带）、
// 都没给就用 DTSTART 的日号。没有这一天的月份直接跳过，不顺延。
function monthSerials(y, mo, rule, startDay) {
  const monthDays = daysInMonth(y, mo);
  const serials = new Set();
  if (rule.byMonthDay.length > 0) {
    for (const md of rule.byMonthDay) {
      const d = md > 0 ? md : monthDays + md + 1;
      if (d >= 1 && d <= monthDays) serials.add(serialOf(y, mo, d));
    }
  } else if (rule.byDay.length > 0) {
    const firstWd = weekdayOfSerial(serialOf(y, mo, 1));
    const lastWd = weekdayOfSerial(serialOf(y, mo, monthDays));
    for (const { ordinal, weekday } of rule.byDay) {
      if (ordinal === null) {
        for (let d = 1 + ((weekday - firstWd + 7) % 7); d <= monthDays; d += 7) {
          serials.add(serialOf(y, mo, d));
        }
      } else if (ordinal > 0) {
        const d = 1 + ((weekday - firstWd + 7) % 7) + (ordinal - 1) * 7;
        if (d <= monthDays) serials.add(serialOf(y, mo, d));
      } else {
        const d = monthDays - ((lastWd - weekday + 7) % 7) + (ordinal + 1) * 7;
        if (d >= 1) serials.add(serialOf(y, mo, d));
      }
    }
  } else if (startDay <= monthDays) {
    serials.add(serialOf(y, mo, startDay));
  }
  return [...serials].sort((a, b) => a - b);
}

// BYSETPOS：对排好序的候选列表取第 n 个，负数是倒数
function applySetPos(serials, bySetPos) {
  if (bySetPos.length === 0) return serials;
  const picked = new Set();
  for (const pos of bySetPos) {
    const idx = pos > 0 ? pos - 1 : serials.length + pos;
    if (idx >= 0 && idx < serials.length) picked.add(serials[idx]);
  }
  return [...picked].sort((a, b) => a - b);
}

// BYMONTH / BYMONTHDAY 作过滤器；DAILY 上 BYDAY 也是过滤器
function dayPasses(serial, rule, filterByDay) {
  const p = wallPartsOf(serial * DAY_MS);
  if (rule.byMonth.length > 0 && !rule.byMonth.includes(p.mo)) return false;
  if (rule.byMonthDay.length > 0) {
    const monthDays = daysInMonth(p.y, p.mo);
    const hit = rule.byMonthDay.some((md) => (md > 0 ? md : monthDays + md + 1) === p.d);
    if (!hit) return false;
  }
  if (filterByDay && rule.byDay.length > 0) {
    const wd = weekdayOfSerial(serial);
    if (!rule.byDay.some((d) => d.weekday === wd)) return false;
  }
  return true;
}

// 第 k 个周期（天 / 周 / 月 / 年）里的候选日序号，升序
function periodSerials(rule, ctx, k) {
  switch (rule.freq) {
    case 'DAILY': {
      const serial = ctx.startSerial + k * rule.interval;
      return dayPasses(serial, rule, true) ? [serial] : [];
    }
    case 'WEEKLY': {
      const weekStart = ctx.weekStartSerial + k * rule.interval * 7;
      const weekdays = rule.byDay.length > 0 ? rule.byDay.map((d) => d.weekday) : [ctx.startWeekday];
      const serials = new Set();
      for (const wd of weekdays) {
        const serial = weekStart + ((wd - ctx.wkstDay + 7) % 7);
        if (dayPasses(serial, rule, false)) serials.add(serial);
      }
      return [...serials].sort((a, b) => a - b);
    }
    case 'MONTHLY': {
      const total = ctx.startY * 12 + (ctx.startMo - 1) + k * rule.interval;
      const y = Math.floor(total / 12);
      const mo = (total % 12) + 1;
      if (rule.byMonth.length > 0 && !rule.byMonth.includes(mo)) return [];
      return applySetPos(monthSerials(y, mo, rule, ctx.startDay), rule.bySetPos);
    }
    case 'YEARLY': {
      const y = ctx.startY + k * rule.interval;
      const months = rule.byMonth.length > 0 ? rule.byMonth : [ctx.startMo];
      const serials = new Set();
      for (const mo of months) {
        for (const serial of monthSerials(y, mo, rule, ctx.startDay)) serials.add(serial);
      }
      return applySetPos([...serials].sort((a, b) => a - b), rule.bySetPos);
    }
    default:
      return [];
  }
}

export function expandSeries(series = {}, options = {}) {
  const tz = series.tz ?? 'UTC';
  if (!isZone(tz)) {
    throw new CalError('ERR_BAD_TZ', `不认识的时区：${series.tz}`, { tz: series.tz });
  }
  const startParsed = parseWall(series.start);
  const duration = series.duration ?? 0;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
    badSeries(`duration 要是非负的分钟数：${series.duration}`, { duration: series.duration });
  }
  const rule = parseRule(series.rule);

  const limit = options.limit ?? DEFAULTS.limit;
  const maxIterations = options.maxIterations ?? DEFAULTS.maxIterations;
  if (!Number.isInteger(limit) || limit < 0) badSeries(`limit 要是非负整数：${limit}`, { limit });
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    badSeries(`maxIterations 要是正整数：${maxIterations}`, { maxIterations });
  }
  const fromMs = parseBound(options.from, 'from');
  const toMs = parseBound(options.to, 'to');

  const exdateSet = new Set();
  for (const value of listOf(series.exdates, 'exdates')) exdateSet.add(parseWall(value).text);

  const overrides = new Map();
  for (const ov of listOf(series.overrides, 'overrides')) {
    const at = parseWall(ov?.at).text;
    let newWall = null;
    if (ov.start !== undefined && ov.start !== null) newWall = parseWall(ov.start).wall;
    let newDuration = null;
    if (ov.duration !== undefined && ov.duration !== null) {
      if (typeof ov.duration !== 'number' || !Number.isFinite(ov.duration) || ov.duration < 0) {
        badSeries(`override 的 duration 要是非负分钟数：${ov.duration}`, { duration: ov.duration });
      }
      newDuration = ov.duration;
    }
    overrides.set(at, { cancelled: ov.cancelled === true, wall: newWall, duration: newDuration });
  }

  const startWall = startParsed.wall;
  const sp = wallPartsOf(startWall);
  const timeMs = sp.h * 3600000 + sp.mi * 60000 + sp.s * 1000;
  const startSerial = Math.floor(startWall / DAY_MS);
  const startWeekday = weekdayOfSerial(startSerial);
  const ctx = {
    startSerial,
    startWeekday,
    wkstDay: WEEKDAYS[rule.wkst],
    weekStartSerial: startSerial - ((startWeekday - WEEKDAYS[rule.wkst] + 7) % 7),
    startY: sp.y,
    startMo: sp.mo,
    startDay: sp.d,
  };
  const untilWall = rule.until === null ? null : parseWall(rule.until).wall;

  // override 优先于 EXDATE：取消就不产出，改期就按新的来；返回 null 表示这次不产出
  const applyExceptions = (occ) => {
    const ov = overrides.get(occ.id);
    if (ov) {
      overrides.delete(occ.id);
      if (ov.cancelled) return null;
      if (ov.wall !== null) occ.wall = ov.wall;
      if (ov.duration !== null) occ.duration = ov.duration;
      occ.modified = true;
      return occ;
    }
    return exdateSet.has(occ.id) ? null : occ;
  };

  const kept = [];
  let keptInWindow = 0; // to 不限时，窗口内的条数就是最终条数，用来提前拦住超上限
  const keep = (occ) => {
    const finalOcc = applyExceptions(occ);
    if (finalOcc === null) return;
    finalOcc.conv = localToUtc(tz, finalOcc.wall);
    kept.push(finalOcc);
    if (fromMs === null || finalOcc.conv.instant >= fromMs) keptInWindow++;
  };

  let produced = 0; // COUNT 数的是规则自己展开出来的次数，EXDATE 不吐名额
  let done = false;
  let iterations = 0;
  for (let k = 0; !done; k++) {
    iterations++;
    if (iterations > maxIterations) {
      throw new CalError('ERR_LIMIT_EXCEEDED', `展开超过 maxIterations=${maxIterations} 还没停`, { maxIterations });
    }
    let minWall = null;
    for (const serial of periodSerials(rule, ctx, k)) {
      const wall = serial * DAY_MS + timeMs;
      if (wall < startWall) continue; // DTSTART 之前的候选直接丢掉
      if (untilWall !== null && wall > untilWall) { done = true; break; } // UNTIL 含边界
      produced++;
      keep({ id: wallText(wall), wall, duration, modified: false });
      if (toMs === null && keptInWindow > limit) {
        throw new CalError('ERR_LIMIT_EXCEEDED', `结果超过 limit=${limit}`, { limit });
      }
      if (rule.count !== null && produced >= rule.count) { done = true; break; }
      if (minWall === null) minWall = wall;
    }
    if (done) break;
    // 候选墙钟只会越来越大，最早候选的时刻下界都过了 to，后面就不可能再落进窗口
    if (rule.count === null && toMs !== null && minWall !== null && minWall - MAX_OFFSET_MIN * 60000 > toMs) {
      break;
    }
  }

  // RDATE 是额外加的发生，不占 COUNT 名额
  for (const value of listOf(series.rdates, 'rdates')) {
    const rd = parseWall(value);
    keep({ id: rd.text, wall: rd.wall, duration, modified: false });
  }

  if (overrides.size > 0) {
    const at = [...overrides.keys()][0];
    throw new CalError('ERR_BAD_OVERRIDE', `override 对不上任何一次发生：${at}`, { at });
  }

  const rows = kept.map((occ) => ({
    occ,
    startMs: occ.conv.instant,
    endMs: localToUtc(tz, occ.wall + occ.duration * 60000).instant, // 时长按墙钟算
  }));
  rows.sort((a, b) => a.startMs - b.startMs || (a.occ.id < b.occ.id ? -1 : a.occ.id > b.occ.id ? 1 : 0));

  const windowed = rows.filter(
    (row) => (fromMs === null || row.startMs >= fromMs) && (toMs === null || row.startMs <= toMs),
  );
  if (windowed.length > limit) {
    throw new CalError('ERR_LIMIT_EXCEEDED', `结果 ${windowed.length} 条，超过 limit=${limit}`, { limit });
  }

  return windowed.map((row, i) => {
    const text = wallText(row.occ.wall);
    return {
      recurrenceId: row.occ.id,
      sequence: i + 1,
      start: isoZ(row.startMs),
      end: isoZ(row.endMs),
      localDate: text.slice(0, 10),
      localTime: text.slice(11),
      offsetMinutes: row.occ.conv.offsetMinutes,
      kind: row.occ.conv.kind,
      modified: row.occ.modified,
    };
  });
}
