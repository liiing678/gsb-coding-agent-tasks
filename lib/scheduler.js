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
const NUMBER_PATTERN = /^\d+$/;

function badCron(message, details) {
  return new SchedulerError('ERR_BAD_CRON', message, details);
}

// 解析 cron 里的一段（分/时/日/月/周），返回该段允许取值的集合。
function parseField(text, field) {
  if (text === '*') {
    return { values: null, restricted: false };
  }
  const values = new Set();
  for (const item of text.split(',')) {
    if (item === '') {
      throw badCron(`cron 段 "${text}" 里有空项`, { field: field.name });
    }
    const parts = item.split('/');
    if (parts.length > 2) {
      throw badCron(`cron 项 "${item}" 不合法`, { field: field.name });
    }
    const [base, stepText] = parts;
    let step = 1;
    if (stepText !== undefined) {
      if (!NUMBER_PATTERN.test(stepText)) {
        throw badCron(`cron 项 "${item}" 的步长不是数字`, { field: field.name });
      }
      step = Number(stepText);
      if (step === 0) {
        throw badCron(`cron 项 "${item}" 的步长不能是 0`, { field: field.name });
      }
    }
    let lo;
    let hi;
    if (base === '*') {
      lo = field.min;
      hi = field.max;
    } else {
      const bounds = base.split('-');
      if (bounds.length > 2 || bounds.some((one) => !NUMBER_PATTERN.test(one))) {
        throw badCron(`cron 项 "${item}" 不合法`, { field: field.name });
      }
      lo = Number(bounds[0]);
      hi = bounds.length === 2 ? Number(bounds[1]) : lo;
      if (bounds.length === 1 && stepText !== undefined) {
        throw badCron(`cron 项 "${item}" 不合法`, { field: field.name });
      }
      if (lo < field.min || hi > field.max) {
        throw badCron(`cron 项 "${item}" 超出 ${field.name} 的范围 ${field.min}~${field.max}`, { field: field.name });
      }
      if (lo > hi) {
        throw badCron(`cron 项 "${item}" 区间反了`, { field: field.name });
      }
    }
    for (let value = lo; value <= hi; value += step) {
      values.add(field.name === 'weekday' && value === 7 ? 0 : value);
    }
  }
  return { values, restricted: true };
}

export function parseCron(expression) {
  if (typeof expression !== 'string') {
    throw badCron('cron 表达式必须是字符串');
  }
  const segments = expression.split(' ');
  if (segments.length !== FIELDS.length || segments.some((one) => one === '')) {
    throw badCron(`cron 表达式必须是 ${FIELDS.length} 段：分 时 日 月 周`);
  }
  const parsed = {};
  FIELDS.forEach((field, index) => {
    parsed[field.name] = parseField(segments[index], field);
  });
  return parsed;
}

function matchesCron(parsed, date) {
  if (parsed.minute.values !== null && !parsed.minute.values.has(date.getUTCMinutes())) return false;
  if (parsed.hour.values !== null && !parsed.hour.values.has(date.getUTCHours())) return false;
  if (parsed.month.values !== null && !parsed.month.values.has(date.getUTCMonth() + 1)) return false;
  const dayHit = !parsed.day.restricted || parsed.day.values.has(date.getUTCDate());
  const weekdayHit = !parsed.weekday.restricted || parsed.weekday.values.has(date.getUTCDay());
  if (parsed.day.restricted && parsed.weekday.restricted) {
    return dayHit || weekdayHit; // 日和周都被限定时取并集
  }
  return dayHit && weekdayHit;
}

export function slot(at) {
  return new Date(Math.floor(at / MINUTE) * MINUTE).toISOString().slice(0, 16) + 'Z';
}

export function createScheduler(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new SchedulerError('ERR_BAD_CONFIG', '配置必须是一个对象');
  }
  const clock = config.clock === undefined ? () => Date.now() : config.clock;
  if (typeof clock !== 'function') {
    throw new SchedulerError('ERR_BAD_CONFIG', 'clock 必须是函数');
  }

  const jobs = [];
  const jobsById = new Map();
  const totals = { planned: 0, ok: 0, failed: 0, skipped: 0, retries: 0 };

  function defineJob(definition) {
    if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new SchedulerError('ERR_BAD_JOB', '任务定义必须是一个对象');
    }
    const { id, cron } = definition;
    if (typeof id !== 'string' || id === '' || !ID_PATTERN.test(id)) {
      throw new SchedulerError('ERR_BAD_JOB', `任务 id "${id}" 不合法`, { id });
    }
    if (jobsById.has(id)) {
      throw new SchedulerError('ERR_BAD_JOB', `任务 "${id}" 已经定义过`, { id });
    }
    const parsed = parseCron(cron);

    const dependsOn = definition.dependsOn === undefined ? [] : definition.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some((one) => typeof one !== 'string')) {
      throw new SchedulerError('ERR_BAD_JOB', 'dependsOn 必须是任务 id 数组', { id });
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new SchedulerError('ERR_BAD_JOB', 'dependsOn 里有重复', { id });
    }
    if (dependsOn.includes(id)) {
      throw new SchedulerError('ERR_CYCLE', `任务 "${id}" 不能依赖自己`, { id });
    }
    for (const dep of dependsOn) {
      if (!jobsById.has(dep)) {
        throw new SchedulerError('ERR_UNKNOWN_DEP', `依赖的任务 "${dep}" 还没定义`, { id, dep });
      }
    }

    const retries = definition.retries === undefined ? DEFAULTS.retries : definition.retries;
    if (!Number.isInteger(retries) || retries < 0) {
      throw new SchedulerError('ERR_BAD_JOB', 'retries 必须是不小于 0 的整数', { id });
    }
    const backoffMs = definition.backoffMs === undefined ? DEFAULTS.backoffMs : definition.backoffMs;
    if (!Number.isInteger(backoffMs) || backoffMs <= 0) {
      throw new SchedulerError('ERR_BAD_JOB', 'backoffMs 必须是大于 0 的整数', { id });
    }

    const level = dependsOn.length === 0
      ? 0
      : 1 + Math.max(...dependsOn.map((dep) => jobsById.get(dep).level));

    const job = { id, cron, parsed, dependsOn, retries, backoffMs, level };
    jobs.push(job);
    jobsById.set(id, job);
    return job;
  }

  function resolvePeriod(args) {
    if (args === null || typeof args !== 'object') {
      throw new SchedulerError('ERR_BAD_PERIOD', '需要 { from, to }');
    }
    const { from } = args;
    const to = args.to === undefined ? clock() : args.to;
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new SchedulerError('ERR_BAD_PERIOD', 'from / to 必须是有限毫秒数');
    }
    if (from > to) {
      throw new SchedulerError('ERR_BAD_PERIOD', 'from 不能大于 to', { from, to });
    }
    return { from, to };
  }

  // 展开 [from, to) 窗口里的所有触发，只认整分钟；依赖指到 at <= 本次 at 的最近一次上游。
  function expand(from, to) {
    const hitsByJob = new Map(jobs.map((job) => [job.id, []]));
    const first = Math.ceil(from / MINUTE) * MINUTE;
    for (let at = first; at < to; at += MINUTE) {
      const date = new Date(at);
      for (const job of jobs) {
        if (matchesCron(job.parsed, date)) {
          hitsByJob.get(job.id).push(at);
        }
      }
    }
    const triggers = [];
    for (const job of jobs) {
      for (const at of hitsByJob.get(job.id)) {
        const dependsOn = [];
        let skipped = null;
        for (const dep of job.dependsOn) {
          const hits = hitsByJob.get(dep);
          let upstream = null;
          for (let index = hits.length - 1; index >= 0; index -= 1) {
            if (hits[index] <= at) {
              upstream = hits[index];
              break;
            }
          }
          if (upstream === null) {
            skipped = 'NO_UPSTREAM';
          } else {
            dependsOn.push(`${dep}@${slot(upstream)}`);
          }
        }
        triggers.push({ id: `${job.id}@${slot(at)}`, jobId: job.id, at, level: job.level, dependsOn, skipped });
      }
    }
    triggers.sort((a, b) => a.at - b.at || a.level - b.level || (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
    return triggers;
  }

  function plan(args) {
    const { from, to } = resolvePeriod(args);
    const triggers = expand(from, to);
    totals.planned += triggers.length;
    return triggers;
  }

  function execute(args) {
    const { from, to } = resolvePeriod(args);
    const perform = args === null || args === undefined ? undefined : args.perform;
    if (typeof perform !== 'function') {
      throw new SchedulerError('ERR_BAD_PERFORM', 'execute 需要一个 perform 函数');
    }
    const triggers = expand(from, to);
    const runsById = new Map();
    const runs = [];

    for (const trigger of triggers) {
      const job = jobsById.get(trigger.jobId);
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

      if (trigger.skipped === 'NO_UPSTREAM') {
        run.status = 'skipped';
        run.reason = 'NO_UPSTREAM';
      } else {
        const upstreams = trigger.dependsOn.map((id) => runsById.get(id));
        if (upstreams.some((one) => one.status === 'failed')) {
          run.status = 'skipped';
          run.reason = 'UPSTREAM_FAILED';
        } else if (upstreams.some((one) => one.status === 'skipped')) {
          run.status = 'skipped';
          run.reason = 'UPSTREAM_SKIPPED';
        }
      }

      if (run.status === null) {
        for (;;) {
          run.attempts += 1;
          const outcome = perform({
            id: run.id, jobId: run.jobId, at: run.at, level: run.level, attempt: run.attempts,
          });
          if (outcome === 'ok') {
            run.status = 'ok';
            break;
          }
          if (outcome === 'fail') {
            run.status = 'failed';
            run.reason = 'FAILED';
            break;
          }
          if (outcome === 'retry') {
            if (run.attempts >= job.retries + 1) {
              run.status = 'failed';
              run.reason = 'RETRIES_EXHAUSTED';
              break;
            }
            const round = run.retryAts.length + 1; // 第几次重试
            run.retryAts.push(run.at + job.backoffMs * 2 ** (round - 1));
            totals.retries += 1;
            continue;
          }
          throw new SchedulerError('ERR_BAD_PERFORM', `perform 返回了不认识的结果：${String(outcome)}`, { id: run.id });
        }
      }

      totals[run.status] += 1;
      runsById.set(run.id, run);
      runs.push(run);
    }

    return { runs, stats: stats() };
  }

  function stats() {
    return {
      jobs: jobs.length,
      longestChain: jobs.length === 0 ? 0 : 1 + Math.max(...jobs.map((job) => job.level)),
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
      return jobs.map((job) => ({
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
