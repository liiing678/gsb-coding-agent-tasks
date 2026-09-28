// 定时任务编排。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/cron.test.js、test/schedule.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import { SchedulerError } from './errors.js';

export const MINUTE = 60000;

export const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'weekday', min: 0, max: 7 },
];

export const DEFAULTS = {
  retries: 0,
  backoffMs: 1000,
};

const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

const badCron = (message, details) => new SchedulerError('ERR_BAD_CRON', message, details);

// 解析 cron 的一段：*、n、a-b、*/n、a-b/n，以及逗号拼起来的列表。
function parseField(text, field) {
  const values = new Set();
  for (const part of text.split(',')) {
    if (part === '') {
      throw badCron(`cron 段 "${text}" 里有空项`, { field: field.name });
    }
    let base = part;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash !== -1) {
      base = part.slice(0, slash);
      const stepText = part.slice(slash + 1);
      if (base !== '*' && !/^\d+-\d+$/.test(base)) {
        throw badCron(`步长只能跟在 * 或区间后面："${part}"`, { field: field.name });
      }
      if (!/^\d+$/.test(stepText)) {
        throw badCron(`步长不是数字："${part}"`, { field: field.name });
      }
      step = Number(stepText);
      if (step === 0) {
        throw badCron(`步长不能是 0："${part}"`, { field: field.name });
      }
    }
    let lo;
    let hi;
    if (base === '*') {
      lo = field.min;
      hi = field.max;
    } else if (/^\d+$/.test(base)) {
      if (slash !== -1) {
        throw badCron(`单个值不能带步长："${part}"`, { field: field.name });
      }
      lo = Number(base);
      hi = lo;
    } else if (/^\d+-\d+$/.test(base)) {
      [lo, hi] = base.split('-').map(Number);
      if (lo > hi) {
        throw badCron(`区间反了："${part}"`, { field: field.name });
      }
    } else {
      throw badCron(`看不懂的写法："${part}"`, { field: field.name });
    }
    if (lo < field.min || hi > field.max) {
      throw badCron(`"${part}" 超出 ${field.name} 的范围 ${field.min}~${field.max}`, { field: field.name });
    }
    for (let value = lo; value <= hi; value += step) {
      values.add(value);
    }
  }
  return values;
}

// 把 5 段 cron 表达式解析成各段的取值集合，一律按 UTC 展开。
// 返回的结构带 matches(date)，日/周都受限时按并集判定，周格 7 归一成 0（周日）。
export function parseCron(expression) {
  if (typeof expression !== 'string') {
    throw badCron('cron 表达式得是字符串');
  }
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== FIELDS.length) {
    throw badCron(`cron 要 5 段，实际 ${expression.trim() === '' ? 0 : parts.length} 段`);
  }
  const parsed = {};
  FIELDS.forEach((field, index) => {
    parsed[field.name] = parseField(parts[index], field);
  });
  // 周日：7 和 0 是同一天，统一存 0。
  if (parsed.weekday.has(7)) {
    parsed.weekday.delete(7);
    parsed.weekday.add(0);
  }
  const dayRestricted = parts[2] !== '*';
  const weekdayRestricted = parts[4] !== '*';
  return {
    ...parsed,
    dayRestricted,
    weekdayRestricted,
    matches(date) {
      if (!parsed.minute.has(date.getUTCMinutes())) return false;
      if (!parsed.hour.has(date.getUTCHours())) return false;
      if (!parsed.month.has(date.getUTCMonth() + 1)) return false;
      const dayHit = parsed.day.has(date.getUTCDate());
      const weekdayHit = parsed.weekday.has(date.getUTCDay());
      if (dayRestricted && weekdayRestricted) return dayHit || weekdayHit;
      if (dayRestricted) return dayHit;
      if (weekdayRestricted) return weekdayHit;
      return true;
    },
  };
}

// 不小于 at 的最小整分钟；from 落在半分钟上时，这一分钟不算。
export function slot(at) {
  return Math.ceil(at / MINUTE) * MINUTE;
}

const minuteLabel = (at) => `${new Date(at).toISOString().slice(0, 16)}Z`;

export function createScheduler(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new SchedulerError('ERR_BAD_CONFIG', '配置得是一个对象');
  }
  const clock = config.clock === undefined ? () => Date.now() : config.clock;
  if (typeof clock !== 'function') {
    throw new SchedulerError('ERR_BAD_CONFIG', 'clock 得是一个函数');
  }

  const jobList = [];
  const jobById = new Map();
  const totals = { planned: 0, ok: 0, failed: 0, skipped: 0, retries: 0 };

  function defineJob(definition) {
    if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new SchedulerError('ERR_BAD_JOB', '任务定义得是一个对象');
    }
    const { id, cron, dependsOn = [], retries = DEFAULTS.retries, backoffMs = DEFAULTS.backoffMs } = definition;
    if (typeof id !== 'string' || id === '' || !ID_PATTERN.test(id)) {
      throw new SchedulerError('ERR_BAD_JOB', `任务 id 不合法：${String(id)}`);
    }
    if (jobById.has(id)) {
      throw new SchedulerError('ERR_BAD_JOB', `任务重名：${id}`);
    }
    const parsed = parseCron(cron);
    if (!Array.isArray(dependsOn) || dependsOn.some((dep) => typeof dep !== 'string')) {
      throw new SchedulerError('ERR_BAD_JOB', 'dependsOn 得是任务 id 的数组');
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new SchedulerError('ERR_BAD_JOB', 'dependsOn 里有重复项');
    }
    if (dependsOn.includes(id)) {
      throw new SchedulerError('ERR_CYCLE', `任务 ${id} 依赖自己`);
    }
    for (const dep of dependsOn) {
      if (!jobById.has(dep)) {
        throw new SchedulerError('ERR_UNKNOWN_DEP', `依赖的任务还没定义：${dep}`);
      }
    }
    if (!Number.isInteger(retries) || retries < 0) {
      throw new SchedulerError('ERR_BAD_JOB', 'retries 得是不小于 0 的整数');
    }
    if (!Number.isInteger(backoffMs) || backoffMs <= 0) {
      throw new SchedulerError('ERR_BAD_JOB', 'backoffMs 得是大于 0 的整数');
    }
    const level = dependsOn.length === 0
      ? 0
      : 1 + Math.max(...dependsOn.map((dep) => jobById.get(dep).level));
    const job = { id, cron, parsed, dependsOn, retries, backoffMs, level };
    jobList.push(job);
    jobById.set(id, job);
    return job;
  }

  function resolvePeriod(from, to) {
    const start = from;
    const end = to === undefined ? clock() : to;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new SchedulerError('ERR_BAD_PERIOD', 'from / to 得是有限毫秒数');
    }
    if (start > end) {
      throw new SchedulerError('ERR_BAD_PERIOD', 'from 不能比 to 大');
    }
    return { start, end };
  }

  // 展开 [from, to) 窗口里所有任务的触发，指好依赖，排好序。
  function expand(from, to) {
    const { start, end } = resolvePeriod(from, to);
    const firstMinute = slot(start);
    const timesByJob = new Map();
    for (const job of jobList) {
      const times = [];
      for (let at = firstMinute; at < end; at += MINUTE) {
        if (job.parsed.matches(new Date(at))) {
          times.push(at);
        }
      }
      timesByJob.set(job.id, times);
    }
    const triggers = [];
    for (const job of jobList) {
      for (const at of timesByJob.get(job.id)) {
        const dependsOnIds = [];
        let missing = false;
        for (const depId of job.dependsOn) {
          const upstreamTimes = timesByJob.get(depId);
          let latest = null;
          for (const upstreamAt of upstreamTimes) {
            if (upstreamAt > at) break;
            latest = upstreamAt;
          }
          if (latest === null) {
            missing = true;
          } else {
            dependsOnIds.push(`${depId}@${minuteLabel(latest)}`);
          }
        }
        triggers.push({
          id: `${job.id}@${minuteLabel(at)}`,
          jobId: job.id,
          at,
          level: job.level,
          dependsOn: dependsOnIds,
          skipped: missing ? 'NO_UPSTREAM' : null,
        });
      }
    }
    triggers.sort((a, b) => {
      if (a.at !== b.at) return a.at - b.at;
      if (a.level !== b.level) return a.level - b.level;
      return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
    });
    return triggers;
  }

  function plan({ from, to } = {}) {
    const triggers = expand(from, to);
    totals.planned += triggers.length;
    return triggers;
  }

  function execute({ from, to, perform } = {}) {
    if (typeof perform !== 'function') {
      throw new SchedulerError('ERR_BAD_PERFORM', 'execute 需要一个 perform 函数');
    }
    const triggers = expand(from, to);
    const outcomeById = new Map();
    const runs = [];
    for (const trigger of triggers) {
      const job = jobById.get(trigger.jobId);
      const run = {
        id: trigger.id,
        jobId: trigger.jobId,
        at: trigger.at,
        level: trigger.level,
        dependsOn: trigger.dependsOn,
        status: null,
        reason: null,
        attempts: 0,
        retryAts: [],
      };
      let skipReason = trigger.skipped;
      if (skipReason === null) {
        const upstreams = trigger.dependsOn.map((id) => outcomeById.get(id));
        if (upstreams.some((one) => one.status === 'failed')) {
          skipReason = 'UPSTREAM_FAILED';
        } else if (upstreams.some((one) => one.status === 'skipped')) {
          skipReason = 'UPSTREAM_SKIPPED';
        }
      }
      if (skipReason !== null) {
        run.status = 'skipped';
        run.reason = skipReason;
        totals.skipped += 1;
        outcomeById.set(run.id, run);
        runs.push(run);
        continue;
      }
      // 第 k 次重试排在 at + backoffMs * 2 ** (k - 1)，额度是 retries 次。
      for (;;) {
        run.attempts += 1;
        const verdict = perform({
          id: run.id,
          jobId: run.jobId,
          at: run.at,
          level: run.level,
          attempt: run.attempts,
        });
        if (verdict === 'ok') {
          run.status = 'ok';
          totals.ok += 1;
          break;
        }
        if (verdict === 'fail') {
          run.status = 'failed';
          run.reason = 'FAILED';
          totals.failed += 1;
          break;
        }
        if (verdict === 'retry') {
          const retryIndex = run.retryAts.length + 1;
          if (retryIndex <= job.retries) {
            run.retryAts.push(run.at + job.backoffMs * 2 ** (retryIndex - 1));
            totals.retries += 1;
            continue;
          }
          run.status = 'failed';
          run.reason = 'RETRIES_EXHAUSTED';
          totals.failed += 1;
          break;
        }
        throw new SchedulerError('ERR_BAD_PERFORM', `perform 返回了不认识的结果：${String(verdict)}`);
      }
      outcomeById.set(run.id, run);
      runs.push(run);
    }
    return { runs, stats: stats() };
  }

  function stats() {
    return {
      jobs: jobList.length,
      longestChain: jobList.length === 0 ? 0 : 1 + Math.max(...jobList.map((job) => job.level)),
      planned: totals.planned,
      ok: totals.ok,
      failed: totals.failed,
      skipped: totals.skipped,
      retries: totals.retries,
    };
  }

  return {
    defineJob,
    plan,
    execute,
    stats,
    get jobs() {
      return jobList.map((job) => ({
        id: job.id,
        cron: job.cron,
        dependsOn: [...job.dependsOn],
        retries: job.retries,
        backoffMs: job.backoffMs,
        level: job.level,
      }));
    },
  };
}
