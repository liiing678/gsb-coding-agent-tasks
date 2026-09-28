// 时区换算：本地墙钟 <-> UTC 时刻。用 Intl 的 tz 数据库，不引第三方包。
//
// 这一层只认"墙钟"，不认识日历规则；同一个墙钟时间在夏令时切换附近可能不存在
// （春季跳表）或出现两次（秋季回拨），两种情况的处理口径见 README。

const formatters = new Map();

function formatterFor(tz) {
  let formatter = formatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, formatter);
  }
  return formatter;
}

export function isZone(tz) {
  try {
    formatterFor(tz).format(0);
    return true;
  } catch {
    return false;
  }
}

export function partsAt(tz, ms) {
  const found = {};
  for (const part of formatterFor(tz).formatToParts(new Date(ms))) found[part.type] = part.value;
  let hour = Number(found.hour);
  if (hour === 24) hour = 0; // en-US 的午夜会写成 24
  return {
    y: Number(found.year),
    mo: Number(found.month),
    d: Number(found.day),
    h: hour,
    mi: Number(found.minute),
    s: Number(found.second),
  };
}

export function wallMsOf(parts) {
  return Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s);
}

export function wallPartsOf(wall) {
  const d = new Date(wall);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

export function wallText(wall) {
  const p = wallPartsOf(wall);
  return `${String(p.y).padStart(4, '0')}-${pad2(p.mo)}-${pad2(p.d)}T${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}`;
}

export function isoZ(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function offsetMinutes(tz, ms) {
  const parts = partsAt(tz, ms);
  return Math.round((wallMsOf(parts) - Math.floor(ms / 1000) * 1000) / 60000);
}

export function utcToLocal(tz, ms) {
  const parts = partsAt(tz, ms);
  return { wall: wallMsOf(parts), offsetMinutes: offsetMinutes(tz, ms) };
}

// 墙钟 -> 时刻。返回 kind：exact / gap（这个墙钟不存在，按跳表之后的偏移往后挪）/ ambiguous（出现两次，取先发生的）
export function localToUtc(tz, wall) {
  const before = offsetMinutes(tz, wall - 86400000);
  const after = offsetMinutes(tz, wall + 86400000);
  if (before === after) return { instant: wall - before * 60000, offsetMinutes: before, kind: 'exact' };

  const candidateBefore = wall - before * 60000;
  const candidateAfter = wall - after * 60000;
  const hitBefore = utcToLocal(tz, candidateBefore).wall === wall;
  const hitAfter = utcToLocal(tz, candidateAfter).wall === wall;

  if (hitBefore && hitAfter) {
    const instant = Math.min(candidateBefore, candidateAfter);
    return { instant, offsetMinutes: offsetMinutes(tz, instant), kind: 'ambiguous' };
  }
  if (hitBefore) return { instant: candidateBefore, offsetMinutes: before, kind: 'exact' };
  if (hitAfter) return { instant: candidateAfter, offsetMinutes: after, kind: 'exact' };
  return { instant: candidateAfter, offsetMinutes: after, kind: 'gap' };
}
