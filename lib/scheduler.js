// 定时调度器：按 cron 表达式（timeZone 本地挂钟时间）算下一次触发时刻，
// 到点把 job 交出去，管住同 job 不重叠、夏令时两种边界和 stop 收尾。
//
// parseCron(expression, timeZone) -> { expression, timeZone, next(afterMs) }
// createScheduler({ config, counters, now, sleep }) -> { add(job), start(), stop(), stats() }
import { CronParseError, SchedulerStateError } from './errors.js';

const MINUTE_MS = 60_000;
const FIELD_BOUNDS = [
  [0, 59], // 分
  [0, 23], // 时
  [1, 31], // 日
  [1, 12], // 月
  [0, 7], // 周（0 和 7 都是周日）
];
// 往后算五年都没有下一个触发点就返回 null。边界稍微放宽一点，保证五个日历年够用。
const NO_MATCH_LIMIT_MS = 5 * 366 * 86_400_000;

function parseField(raw, min, max) {
  if (typeof raw !== 'string' || raw === '') {
    throw new CronParseError(`cron 字段为空或不是字符串: ${raw}`);
  }
  const values = new Set();
  for (const term of raw.split(',')) {
    const match = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(term);
    if (!match) {
      throw new CronParseError(`cron 字段看不懂: ${term}`);
    }
    const [, isStar, startRaw, endRaw, stepRaw] = match;
    if (stepRaw !== undefined && Number(stepRaw) < 1) {
      throw new CronParseError(`步长得 >= 1: ${term}`);
    }
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    let start;
    let end;
    if (isStar) {
      start = min;
      end = max;
    } else {
      start = Number(startRaw);
      end = endRaw === undefined ? start : Number(endRaw);
      // a/n 这种没写全范围的形式不在支持的语法里。
      if (stepRaw !== undefined && endRaw === undefined) {
        throw new CronParseError(`带步长得写成 */n 或 a-b/n: ${term}`);
      }
    }
    if (start < min || end > max || start > end) {
      throw new CronParseError(`cron 字段超出范围 ${min}-${max}: ${term}`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return { values, star: raw === '*' };
}

export function parseCron(expression, timeZone) {
  if (typeof expression !== 'string') {
    throw new CronParseError('cron 表达式得是字符串');
  }
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(`cron 表达式得是五段: ${expression}`);
  }
  const fields = parts.map((part, index) => {
    const [min, max] = FIELD_BOUNDS[index];
    return parseField(part, min, max);
  });
  // 周：7 归一到 0（都是周日）。
  if (fields[4].values.has(7)) {
    fields[4].values.delete(7);
    fields[4].values.add(0);
  }

  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    // 有些平台对非法时区是懒着报错的，这里逼着它算一次。
    formatter.formatToParts(0);
  } catch {
    throw new CronParseError(`不认识的时区: ${timeZone}`);
  }

  function wallParts(ms) {
    const value = {};
    for (const part of formatter.formatToParts(new Date(ms))) {
      if (part.type !== 'literal') {
        value[part.type] = Number(part.value);
      }
    }
    return value;
  }

  // 把一段本地挂钟分钟（wallUtc：把挂钟数字当成 UTC 解释出来的毫秒）换算成真实瞬间。
  // 反复按当时偏移纠正：能收敛到同一挂钟数字就是有效时间（重复出现的小时会收敛到第一次）；
  // 在两个瞬间之间来回振荡，说明这个挂钟分钟在春令时缺口里，根本不存在。
  function toInstant(wallUtc) {
    let instant = wallUtc;
    const seen = new Set();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const wall = wallParts(instant);
      const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
      if (asUtc === wallUtc) {
        return { gap: false, instant };
      }
      if (seen.has(instant)) {
        return { gap: true };
      }
      seen.add(instant);
      instant -= asUtc - wallUtc;
    }
    return { gap: true };
  }

  function dayMatches(dom, dow) {
    const domOk = fields[2].values.has(dom);
    const dowOk = fields[4].values.has(dow);
    // 日和周都写死了按“或”；只要有一个是 *，就退化成普通的“与”。
    if (fields[2].star || fields[4].star) {
      return domOk && dowOk;
    }
    return domOk || dowOk;
  }

  function next(afterMs) {
    const start = wallParts(afterMs);
    let wallUtc = Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute) + MINUTE_MS;
    const limit = wallUtc + NO_MATCH_LIMIT_MS;
    while (wallUtc <= limit) {
      const wallDate = new Date(wallUtc);
      const minute = wallDate.getUTCMinutes();
      const hour = wallDate.getUTCHours();
      const dom = wallDate.getUTCDate();
      const month = wallDate.getUTCMonth() + 1;
      const dow = wallDate.getUTCDay();
      if (
        fields[0].values.has(minute) &&
        fields[1].values.has(hour) &&
        fields[3].values.has(month) &&
        dayMatches(dom, dow)
      ) {
        let resolved = wallUtc;
        let result = toInstant(resolved);
        // 缺口里的挂钟分钟：顺延到缺口之后第一个真实存在的整分钟，只触发这一次。
        while (result.gap) {
          resolved += MINUTE_MS;
          result = toInstant(resolved);
        }
        // 回拨夜里同一挂钟分钟出现两次时，toInstant 收敛到第一次；
        // 第一次已经在 afterMs 之前就整体跳过（第二次不触发）。
        if (result.instant > afterMs) {
          return result.instant;
        }
      }
      wallUtc += MINUTE_MS;
    }
    return null;
  }

  return { expression, timeZone, next };
}

export function createScheduler({
  config,
  counters,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!config) {
    throw new Error('createScheduler 需要 config');
  }
  if (!counters) {
    throw new Error('createScheduler 需要 counters');
  }

  const jobs = new Map();
  // name -> 正在跑的那次 run 返回的 promise；同一条 job 同时最多一个。
  const running = new Map();
  let started = false;
  let stopping = false;
  let stopPromise = null;
  let releaseStopGate;
  const stopGate = new Promise((resolve) => {
    releaseStopGate = resolve;
  });

  function add({ name, cron, run, timeZone } = {}) {
    if (started || stopping) {
      throw new SchedulerStateError('start() 之后不能再 add，stop() 之后也不行');
    }
    if (typeof name !== 'string' || name === '') {
      throw new SchedulerStateError('job 的 name 得是非空字符串');
    }
    if (jobs.has(name)) {
      throw new SchedulerStateError(`job 重名了: ${name}`);
    }
    if (typeof run !== 'function') {
      throw new SchedulerStateError(`job ${name} 的 run 得是函数`);
    }
    const jobTimeZone = timeZone ?? config.timeZone;
    const parsed = parseCron(cron, jobTimeZone);
    jobs.set(name, { name, run, cron: parsed });
    counters.inc('tickwheel_jobs_total');
  }

  async function runLoop(job) {
    // 已经触发过的时刻；时钟回拨之后靠它保证同一个时间点不跑第二遍。
    let lastTick = -Infinity;
    while (!stopping) {
      const anchor = Math.max(now(), lastTick);
      const due = job.cron.next(anchor);
      if (due === null) {
        return;
      }
      const delay = due - now();
      if (delay > 0) {
        await Promise.race([sleep(delay), stopGate]);
        if (stopping) {
          return;
        }
      }
      if (now() < due || due <= lastTick) {
        continue;
      }
      lastTick = due;
      if (running.has(job.name)) {
        // 上一次还没结束：这一跳只记一笔，不排队、不并发。
        counters.inc('tickwheel_overlap_skipped_total');
        continue;
      }
      counters.inc('tickwheel_fired_total');
      let settled = false;
      const execution = Promise.resolve().then(() => job.run(due));
      running.set(job.name, execution);
      execution.then(
        () => finish(),
        () => {
          counters.inc('tickwheel_failed_total');
          finish();
        },
      );
      function finish() {
        if (settled) {
          return;
        }
        settled = true;
        running.delete(job.name);
      }
    }
  }

  function start() {
    if (stopping) {
      throw new SchedulerStateError('stop() 之后不能再 start()');
    }
    if (started) {
      return;
    }
    started = true;
    for (const job of jobs.values()) {
      runLoop(job);
    }
  }

  function stop() {
    if (stopPromise) {
      return stopPromise;
    }
    stopping = true;
    releaseStopGate();
    stopPromise = (async () => {
      // stop 之后不会再有新的 run 被开出来，等手里这些跑完就行。
      while (running.size > 0) {
        await Promise.allSettled([...running.values()]);
      }
    })();
    return stopPromise;
  }

  function stats() {
    return {
      timeZone: config.timeZone,
      jobs: [...jobs.keys()],
      running: [...running.keys()],
      counters: counters.snapshot(),
    };
  }

  return { add, start, stop, stats };
}
