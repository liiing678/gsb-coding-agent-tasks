// 调度器对外只抛这一个错误类型，调用方按 code 分流。
export const CODES = [
  'ERR_BAD_CONFIG',
  'ERR_BAD_JOB',
  'ERR_BAD_CRON',
  'ERR_UNKNOWN_DEP',
  'ERR_CYCLE',
  'ERR_BAD_PERIOD',
  'ERR_BAD_PERFORM',
];

export class SchedulerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
    this.details = details;
  }
}
