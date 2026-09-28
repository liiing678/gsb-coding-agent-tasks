// 调度器本体：cron 解析、时区/夏令时换算、到点触发、不重叠、stop 收尾。
//
// 时间一律从参数注入：当前时间用 now，等待用 sleep，这里不碰 Date.now / setTimeout。
import { CronParseError, SchedulerStateError } from './errors.js';

const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;
// 本地时间不存在时，往后顺延找第一个存在的分钟；跳表空隙不会比这更长。
const MAX_GAP_MINUTES = 25 * 60;
// 换算本地时间 -> epoch 时，在这个窗口里采样两侧可能的 UTC 偏移（覆盖重复小时的两种偏移）。
const OFFSET_SAMPLES = [-26 * HOUR, -13 * HOUR, 0, 13 * HOUR, 26 * HOUR];
// next() 往后找五年，算不出来就返回 null。
const SEARCH_LIMIT = 5 * 366 * DAY;

const FIELDS = [
  { name: '分', min: 0, max: 59 },
  { name: '时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '周', min: 0, max: 7 },
];

function parseField(spec, index) {
  const { name, min, max } = FIELDS[index];
  const isDow = index === 4;
  const fail = (why) => {
    throw new CronParseError(`cron 第 ${index + 1} 段（${name}）看不懂: "${spec}"（${why}）`);
  };

  const values = new Set();
  for (const part of spec.split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) {
      fail('只支持 *、a、a-b、*/n、a-b/n');
    }
    const [, first, second, stepText] = m;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) {
      fail('步长必须 >= 1');
    }
    if (stepText !== undefined && first !== '*' && second === undefined) {
      fail('步长只能跟在 * 或 a-b 后面');
    }
    let lo;
    let hi;
    if (first === '*') {
      if (second !== undefined) {
        fail('* 后面不能接范围');
      }
      lo = min;
      hi = max;
    } else {
      lo = Number(first);
      hi = second === undefined ? lo : Number(second);
      if (lo < min || hi > max) {
        fail(`取值要在 ${min}-${max} 之间`);
      }
      if (lo > hi) {
        fail('范围起点不能大于终点');
      }
    }
    for (let v = lo; v <= hi; v += step) {
      // 周几里 0 和 7 都是周日。
      values.add(isDow && v === 7 ? 0 : v);
    }
  }
  return { values, star: spec === '*' };
}

export function parseCron(expression, timeZone) {
  if (typeof expression !== 'string') {
    throw new CronParseError('cron 表达式必须是字符串');
  }
  if (typeof timeZone !== 'string' || timeZone === '') {
    throw new CronParseError(`不认识的时区: ${timeZone}`);
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
      second: '2-digit',
    });
    formatter.format(0);
  } catch {
    throw new CronParseError(`不认识的时区: ${timeZone}`);
  }

  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(`cron 表达式要五段（分 时 日 月 周）: "${expression}"`);
  }
  const [minutes, hours, dom, months, dow] = parts.map((part, i) => parseField(part, i));
  const minuteList = [...minutes.values].sort((a, b) => a - b);
  const hourList = [...hours.values].sort((a, b) => a - b);

  // epoch -> 该时区的本地时间，用 UTC 毫秒表示本地字段，方便直接做算术。
  function toLocalMs(epoch) {
    const out = {};
    for (const part of formatter.formatToParts(epoch)) {
      if (part.type !== 'literal') {
        out[part.type] = Number(part.value);
      }
    }
    return Date.UTC(out.year, out.month - 1, out.day, out.hour, out.minute, out.second);
  }

  // 本地时间（UTC 毫秒表示）-> 第一次出现的 epoch；本地时间不存在时返回 null。
  function matchLocal(localMs) {
    const offsets = new Set();
    for (const delta of OFFSET_SAMPLES) {
      const at = localMs + delta;
      offsets.add(toLocalMs(at) - at);
    }
    let best = null;
    for (const offset of offsets) {
      const candidate = localMs - offset;
      if (toLocalMs(candidate) === localMs && (best === null || candidate < best)) {
        best = candidate;
      }
    }
    return best;
  }

  // 本地时间 -> epoch：不存在的分钟顺延到跳表之后第一个存在的分钟；重复的分钟取第一次。
  function localToEpoch(localMs) {
    for (let k = 0; k <= MAX_GAP_MINUTES; k += 1) {
      const hit = matchLocal(localMs + k * MINUTE);
      if (hit !== null) {
        return hit;
      }
    }
    return null;
  }

  function dayMatches(dayOfMonth, dayOfWeek) {
    const domOk = dom.values.has(dayOfMonth);
    const dowOk = dow.values.has(dayOfWeek);
    if (dom.star && dow.star) {
      return true;
    }
    if (dom.star) {
      return dowOk;
    }
    if (dow.star) {
      return domOk;
    }
    // 日和周都写死的时候按"或"算。
    return domOk || dowOk;
  }

  function next(afterMs) {
    const localStart = toLocalMs(afterMs);
    const limitLocal = localStart + SEARCH_LIMIT;
    let dayStart = Math.floor(localStart / DAY) * DAY;
    while (dayStart <= limitLocal) {
      const date = new Date(dayStart);
      if (months.values.has(date.getUTCMonth() + 1) && dayMatches(date.getUTCDate(), date.getUTCDay())) {
        let best = null;
        for (const hour of hourList) {
          for (const minute of minuteList) {
            const localMs = dayStart + hour * HOUR + minute * MINUTE;
            // 偏移最大 14 小时，超出这个窗口的候选不可能落在 afterMs 之后。
            if (localMs + 14 * HOUR <= afterMs) {
              continue;
            }
            if (best !== null && localMs - 14 * HOUR >= best) {
              break;
            }
            const epoch = localToEpoch(localMs);
            if (epoch !== null && epoch > afterMs && (best === null || epoch < best)) {
              best = epoch;
            }
          }
        }
        if (best !== null) {
          return best;
        }
      }
      dayStart += DAY;
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
  let state = 'idle'; // idle -> running -> stopped
  let runningCount = 0;
  let stopPromise = null;
  let stopResolve = null;

  function settleStop() {
    if (stopResolve && runningCount === 0) {
      const resolve = stopResolve;
      stopResolve = null;
      resolve();
    }
  }

  function finishRun(job, failed) {
    if (failed) {
      counters.inc('tickwheel_failed_total');
    }
    job.running = false;
    runningCount -= 1;
    settleStop();
  }

  function fire(job, at) {
    job.running = true;
    runningCount += 1;
    counters.inc('tickwheel_fired_total');
    let result;
    try {
      result = job.run(at);
    } catch {
      finishRun(job, true);
      return;
    }
    Promise.resolve(result).then(
      () => finishRun(job, false),
      () => finishRun(job, true),
    );
  }

  async function loop(job) {
    while (state === 'running') {
      const at = job.nextAt;
      if (at === null) {
        return;
      }
      if (at - now() > 0) {
        try {
          await sleep(at - now());
        } catch {
          return;
        }
        continue;
      }
      if (job.running) {
        // 上一次还没跑完：跳过这一次，记一笔，不排队。
        counters.inc('tickwheel_overlap_skipped_total');
      } else {
        fire(job, at);
      }
      // 以上一次该触发的时间点为基准往后算：时钟回拨也不会重复触发同一个点。
      job.nextAt = job.parsed.next(at);
    }
  }

  return {
    add({ name, cron, run, timeZone } = {}) {
      if (state !== 'idle') {
        throw new SchedulerStateError('start() 之后不能再 add()');
      }
      if (typeof name !== 'string' || name === '') {
        throw new SchedulerStateError('job 的 name 必须是非空字符串');
      }
      if (jobs.has(name)) {
        throw new SchedulerStateError(`job 重名: ${name}`);
      }
      if (typeof run !== 'function') {
        throw new SchedulerStateError(`job ${name} 的 run 必须是函数`);
      }
      const parsed = parseCron(cron, timeZone ?? config.timeZone);
      jobs.set(name, { name, run, parsed, nextAt: null, running: false });
      counters.inc('tickwheel_jobs_total');
    },

    start() {
      if (state === 'stopped') {
        throw new SchedulerStateError('stop() 之后不能再 start()');
      }
      if (state === 'running') {
        return;
      }
      state = 'running';
      const at = now();
      for (const job of jobs.values()) {
        job.nextAt = job.parsed.next(at);
        job.running = false;
        loop(job).catch(() => {});
      }
    },

    stop() {
      if (!stopPromise) {
        state = 'stopped';
        // 不再触发新的；正在跑的等它们跑完才 resolve。
        stopPromise = new Promise((resolve) => {
          stopResolve = resolve;
        });
        settleStop();
      }
      return stopPromise;
    },

    stats() {
      return {
        timeZone: config.timeZone,
        jobs: [...jobs.keys()],
        running: [...jobs.values()].filter((job) => job.running).map((job) => job.name),
        counters: counters.snapshot(),
      };
    },
  };
}
