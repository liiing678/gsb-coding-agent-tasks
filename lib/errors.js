// 错误类型：这部分已经定好了，别改。

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

// cron 表达式看不懂，或者时区名字不认识。
export class CronParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CronParseError';
    this.code = 'cron_parse';
  }
}

// 调度器的用法不对：重名、start() 之后再 add()、stop() 之后再 start()。
export class SchedulerStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchedulerStateError';
    this.code = 'bad_state';
  }
}
