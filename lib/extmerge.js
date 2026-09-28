// 有界内存的外部归并排序。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/sort.test.js、test/bash.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import fs from 'node:fs';
import path from 'node:path';

import { MergeError } from './errors.js';

export const DEFAULTS = {
  maxInMemory: 16,
  fanIn: 4,
};

export function createSorter(config = {}) {
  if (config === null || typeof config !== 'object') {
    throw new MergeError('ERR_BAD_CONFIG', 'createSorter 的配置必须是一个对象');
  }

  const { compare, spillDir } = config;
  const maxInMemory = config.maxInMemory === undefined
    ? DEFAULTS.maxInMemory
    : config.maxInMemory;
  const fanIn = config.fanIn === undefined ? DEFAULTS.fanIn : config.fanIn;

  if (typeof compare !== 'function') {
    throw new MergeError('ERR_BAD_CONFIG', 'compare 必须是一个函数');
  }
  if (!Number.isInteger(maxInMemory) || maxInMemory <= 0) {
    throw new MergeError('ERR_BAD_CONFIG', 'maxInMemory 必须是正整数');
  }
  if (!Number.isInteger(fanIn) || fanIn < 2) {
    throw new MergeError('ERR_BAD_CONFIG', 'fanIn 必须是不小于 2 的整数');
  }

  let dirStat;
  try {
    dirStat = fs.statSync(spillDir);
  } catch (err) {
    throw new MergeError('ERR_BAD_CONFIG', 'spillDir 必须是一个已经存在的目录', { cause: err });
  }
  if (!dirStat.isDirectory()) {
    throw new MergeError('ERR_BAD_CONFIG', 'spillDir 必须是一个已经存在的目录');
  }

  // push 阶段的缓冲区：条数永远不超过 maxInMemory。
  let buffer = [];
  // 盘上还活着的 run 文件名，按编号从小到大。
  let runs = [];
  // 这次会话写出去、还没删掉的全部临时文件，收尾时兜底清空。
  const filesOnDisk = new Set();
  let nextRunIndex = 1;

  let pushed = 0;
  let spilled = 0;
  let spilledRuns = 0;
  let peakBuffered = 0;
  let passes = 0;
  let finished = false;

  // compare 相等时用到达序号兜底，保证稳定。
  const compareRecords = (left, right) =>
    compare(left.item, right.item) || (left.seq - right.seq);

  const io = (action, fn) => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof MergeError) throw err;
      throw new MergeError('ERR_IO', `溢出文件${action}失败`, { cause: err });
    }
  };

  const runPath = (name) => path.join(spillDir, name);

  const runFileName = (index) => `run-${String(index).padStart(4, '0')}.jsonl`;

  // 整批写成下一个编号的 run，返回文件名。
  const writeRun = (records) => {
    const name = runFileName(nextRunIndex);
    nextRunIndex += 1;
    const body = records
      .map((record) => `${JSON.stringify(record)}\n`)
      .join('');
    io('写入', () => fs.writeFileSync(runPath(name), body, 'utf8'));
    filesOnDisk.add(name);
    spilled += records.length;
    spilledRuns += 1;
    return name;
  };

  // 归并阶段整份读进来（这一版不做流式读）。
  const readRun = (name) => io('读取', () => {
    const text = fs.readFileSync(runPath(name), 'utf8');
    return text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line));
  });

  const removeRun = (name) => io('删除', () => {
    fs.unlinkSync(runPath(name));
    filesOnDisk.delete(name);
  });

  // 缓冲区先排好序再落盘，绝不把乱序的原始批扔到文件里。
  const spillBuffer = () => {
    buffer.sort(compareRecords);
    runs.push(writeRun(buffer));
    buffer = [];
  };

  // 多路归并：每一路内部有序，每步挑各路队头最小的一条。
  const mergeTogether = (groups) => {
    const cursors = groups.map(() => 0);
    const merged = [];
    for (;;) {
      let chosen = -1;
      for (let index = 0; index < groups.length; index += 1) {
        if (cursors[index] >= groups[index].length) continue;
        if (chosen === -1
          || compareRecords(groups[index][cursors[index]],
            groups[chosen][cursors[chosen]]) < 0) {
          chosen = index;
        }
      }
      if (chosen === -1) return merged;
      merged.push(groups[chosen][cursors[chosen]]);
      cursors[chosen] += 1;
    }
  };

  // 一轮：按文件编号顺序分组，一组最多 fanIn 个，各合成下一个编号的 run；
  // 单出来的一组（哪怕只有一个输入 run）也照样复制成新文件，编号接着走。
  const mergePass = (current) => {
    const produced = [];
    for (let start = 0; start < current.length; start += fanIn) {
      const group = current.slice(start, start + fanIn);
      const merged = mergeTogether(group.map(readRun));
      produced.push(writeRun(merged));
      for (const name of group) removeRun(name);
    }
    return produced;
  };

  const cleanupFiles = () => {
    for (const name of filesOnDisk) removeRun(name);
    filesOnDisk.clear();
  };

  const push = (item) => {
    if (finished) {
      throw new MergeError('ERR_STATE', '排序器已经收尾，不能再 push');
    }
    // 在记进统计、进缓冲区之前先验能不能序列化：
    // undefined / 函数 / symbol 返回 undefined，BigInt / 循环引用直接抛。
    let serialized;
    try {
      serialized = JSON.stringify(item);
    } catch (err) {
      throw new MergeError('ERR_BAD_VALUE', 'push 的条目无法 JSON 序列化', { cause: err });
    }
    if (typeof serialized !== 'string') {
      throw new MergeError('ERR_BAD_VALUE', 'push 的条目无法 JSON 序列化');
    }

    pushed += 1;
    buffer.push({ seq: pushed - 1, item });
    if (buffer.length > peakBuffered) peakBuffered = buffer.length;
    if (buffer.length === maxInMemory) spillBuffer();
  };

  const finish = () => {
    if (finished) {
      throw new MergeError('ERR_STATE', '排序器已经收尾，不能再 finish');
    }
    finished = true;

    // 一条 run 都没落过：直接在内存里排完，不碰磁盘。
    if (runs.length === 0) {
      buffer.sort(compareRecords);
      const result = buffer.map((record) => record.item);
      buffer = [];
      return result;
    }

    // 盘上已经有 run，内存里剩的这一批也排好落成一个 run。
    if (buffer.length > 0) spillBuffer();

    // 一轮一轮把路数压下来；超过 fanIn 才落中间文件。
    while (runs.length > fanIn) {
      runs = mergePass(runs);
      passes += 1;
    }
    // 盘上本来就只有 1 个 run 时不算轮数；2..fanIn 个 run 最后在内存里合一回。
    if (runs.length > 1) passes += 1;

    const groups = runs.map(readRun);
    const merged = runs.length === 1 ? groups[0] : mergeTogether(groups);

    // 这次写出去的临时文件一个不剩地删掉。
    cleanupFiles();
    runs = [];
    buffer = [];
    return merged.map((record) => record.item);
  };

  const stats = () => ({ pushed, spilled, spilledRuns, peakBuffered, passes });

  return { push, finish, stats };
}
