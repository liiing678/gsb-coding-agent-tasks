// RRULE 子集的解析与校验。展开逻辑不在这里。
import { CalError } from './errors.js';
import { wallMsOf, wallPartsOf } from './tz.js';

export const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
export const WEEKDAY_NAMES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

export const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

// 'YYYY-MM-DDTHH:MM:SS' -> { wall, text }，wall 是把墙钟当作 UTC 毫秒的时间轴位置
export function parseWall(value) {
  const m = TIME_RE.exec(String(value ?? ''));
  if (!m) {
    throw new CalError('ERR_BAD_TIME', `时间要写成 YYYY-MM-DDTHH:MM:SS：${value}`, { value });
  }
  const parts = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
  const wall = wallMsOf(parts);
  const back = wallPartsOf(wall);
  if (
    back.y !== parts.y || back.mo !== parts.mo || back.d !== parts.d ||
    back.h !== parts.h || back.mi !== parts.mi || back.s !== parts.s
  ) {
    throw new CalError('ERR_BAD_TIME', `这个时间不存在：${value}`, { value });
  }
  return { wall, text: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` };
}

function badRule(message, details) {
  throw new CalError('ERR_BAD_RULE', message, details);
}

function unsupported(message, details) {
  throw new CalError('ERR_UNSUPPORTED_RULE', message, details);
}

export function parseRule(text) {
  if (typeof text !== 'string' || text.trim() === '') badRule('rule 不能是空的');
  const rule = {
    freq: null,
    interval: 1,
    count: null,
    until: null,
    byDay: [],
    byMonthDay: [],
    byMonth: [],
    bySetPos: [],
    wkst: 'MO',
  };

  for (const chunk of text.split(';')) {
    if (chunk.trim() === '') continue;
    const eq = chunk.indexOf('=');
    if (eq < 0) badRule(`这一段看不懂：${chunk}`, { chunk });
    const key = chunk.slice(0, eq).trim().toUpperCase();
    const value = chunk.slice(eq + 1).trim().toUpperCase();
    const list = value.split(',');

    switch (key) {
      case 'FREQ': {
        if (!FREQS.includes(value)) unsupported(`不支持的 FREQ=${value}`, { freq: value });
        rule.freq = value;
        break;
      }
      case 'INTERVAL': {
        if (!/^\d+$/.test(value) || Number(value) < 1) badRule(`INTERVAL 要是正整数：${value}`, { value });
        rule.interval = Number(value);
        break;
      }
      case 'COUNT': {
        if (!/^\d+$/.test(value) || Number(value) < 1) badRule(`COUNT 要是正整数：${value}`, { value });
        rule.count = Number(value);
        break;
      }
      case 'UNTIL': {
        rule.until = parseWall(value).text;
        break;
      }
      case 'BYDAY': {
        for (const token of list) {
          const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token);
          if (!m) badRule(`BYDAY 里这一段看不懂：${token}`, { token });
          rule.byDay.push({
            ordinal: m[1] === undefined ? null : Number(m[1]),
            weekday: WEEKDAYS[m[2]],
          });
        }
        break;
      }
      case 'BYMONTHDAY': {
        for (const token of list) {
          if (!/^-?\d+$/.test(token) || Number(token) === 0 || Math.abs(Number(token)) > 31) {
            badRule(`BYMONTHDAY 取值不对：${token}`, { token });
          }
          rule.byMonthDay.push(Number(token));
        }
        break;
      }
      case 'BYMONTH': {
        for (const token of list) {
          if (!/^\d+$/.test(token) || Number(token) < 1 || Number(token) > 12) {
            badRule(`BYMONTH 取值不对：${token}`, { token });
          }
          rule.byMonth.push(Number(token));
        }
        break;
      }
      case 'BYSETPOS': {
        for (const token of list) {
          if (!/^-?\d+$/.test(token) || Number(token) === 0) badRule(`BYSETPOS 取值不对：${token}`, { token });
          rule.bySetPos.push(Number(token));
        }
        break;
      }
      case 'WKST': {
        if (!(value in WEEKDAYS)) badRule(`WKST 取值不对：${value}`, { value });
        rule.wkst = value;
        break;
      }
      case 'BYWEEKNO':
      case 'BYYEARDAY':
        unsupported(`这一版不支持 ${key}`, { key });
        break;
      default:
        badRule(`不认识的 key：${key}`, { key });
    }
  }

  if (rule.freq === null) badRule('rule 里必须有 FREQ');
  if (rule.count !== null && rule.until !== null) badRule('COUNT 和 UNTIL 只能给一个');

  const ordinals = rule.byDay.filter((d) => d.ordinal !== null).length;
  if (ordinals > 0 && ordinals !== rule.byDay.length) {
    badRule('BYDAY 里带序数和不带序数的不能混着给');
  }
  if (ordinals > 0 && rule.freq !== 'MONTHLY' && rule.freq !== 'YEARLY') {
    badRule('带序数的 BYDAY（比如 2TU / -1FR）只能用在 MONTHLY / YEARLY 上');
  }
  if (rule.bySetPos.length > 0 && rule.freq !== 'MONTHLY' && rule.freq !== 'YEARLY') {
    unsupported('BYSETPOS 只支持 MONTHLY / YEARLY', { freq: rule.freq });
  }
  if (rule.byMonthDay.length > 0 && rule.byDay.length > 0) {
    unsupported('BYMONTHDAY 和 BYDAY 不能同时给', {});
  }
  if (rule.freq === 'WEEKLY' && rule.byMonth.length > 0) {
    unsupported('WEEKLY 上不支持 BYMONTH', {});
  }
  return rule;
}
