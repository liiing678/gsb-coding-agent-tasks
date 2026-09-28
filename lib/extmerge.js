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

const isPositiveInteger = (value) => Number.isInteger(value) && value >= 1;

const runName = (number) => `run-${String(number).padStart(4, '0')}.jsonl`;

function resolveConfig(config) {
  if (config === null || typeof config !== 'object') {
    throw new MergeError('ERR_BAD_CONFIG', 'createSorter 的配置必须是一个对象');
  }
  if (typeof config.compare !== 'function') {
    throw new MergeError('ERR_BAD_CONFIG', 'compare 必须是一个函数');
  }
  const maxInMemory = config.maxInMemory ?? DEFAULTS.maxInMemory;
  if (!isPositiveInteger(maxInMemory)) {
    throw new MergeError('ERR_BAD_CONFIG', 'maxInMemory 必须是正整数');
  }
  const fanIn = config.fanIn ?? DEFAULTS.fanIn;
  if (!Number.isInteger(fanIn) || fanIn < 2) {
    throw new MergeError('ERR_BAD_CONFIG', 'fanIn 必须是不小于 2 的整数');
  }
  const { spillDir } = config;
  if (typeof spillDir !== 'string' || spillDir === '') {
    throw new MergeError('ERR_BAD_CONFIG', 'spillDir 必须是一个已经存在的目录');
  }
  let stat;
  try {
    stat = fs.statSync(spillDir);
  } catch (cause) {
    throw new MergeError('ERR_BAD_CONFIG', `spillDir 打不开：${spillDir}`, { cause });
  }
  if (!stat.isDirectory()) {
    throw new MergeError('ERR_BAD_CONFIG', `spillDir 不是目录：${spillDir}`);
  }
  return { compare: config.compare, maxInMemory, fanIn, spillDir };
}

export function createSorter(config = {}) {
  const { compare, maxInMemory, fanIn, spillDir } = resolveConfig(config);

  let pushed = 0;
  let spilled = 0;
  let runCounter = 0;
  let peakBuffered = 0;
  let passes = 0;
  let finished = false;
  let buffer = [];
  const onDisk = new Set();

  const ordered = (left, right) => compare(left.item, right.item) || left.seq - right.seq;

  const runPath = (name) => path.join(spillDir, name);

  const writeRun = (name, records) => {
    let text;
    try {
      text = records
        .map((record) => `${JSON.stringify({ seq: record.seq, item: record.item })}\n`)
        .join('');
      fs.writeFileSync(runPath(name), text, 'utf8');
    } catch (cause) {
      throw new MergeError('ERR_IO', `写溢出文件失败：${name}`, { cause, file: name });
    }
  };

  const readRun = (name) => {
    let raw;
    try {
      raw = fs.readFileSync(runPath(name), 'utf8');
    } catch (cause) {
      throw new MergeError('ERR_IO', `读溢出文件失败：${name}`, { cause, file: name });
    }
    try {
      return raw
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line));
    } catch (cause) {
      throw new MergeError('ERR_IO', `溢出文件内容坏掉了：${name}`, { cause, file: name });
    }
  };

  const removeRun = (name) => {
    try {
      fs.rmSync(runPath(name));
    } catch (cause) {
      throw new MergeError('ERR_IO', `删溢出文件失败：${name}`, { cause, file: name });
    }
    onDisk.delete(name);
  };

  const spill = (records) => {
    const name = runName(++runCounter);
    writeRun(name, records);
    onDisk.add(name);
    spilled += records.length;
    return name;
  };

  const mergeRecords = (lists) => {
    const positions = lists.map(() => 0);
    const merged = [];
    for (;;) {
      let winner = -1;
      for (let index = 0; index < lists.length; index += 1) {
        if (positions[index] >= lists[index].length) continue;
        if (winner === -1
          || ordered(lists[index][positions[index]], lists[winner][positions[winner]]) < 0) {
          winner = index;
        }
      }
      if (winner === -1) return merged;
      merged.push(lists[winner][positions[winner]]);
      positions[winner] += 1;
    }
  };

  const mergePass = (names) => {
    const outputs = [];
    for (let start = 0; start < names.length; start += fanIn) {
      const group = names.slice(start, start + fanIn).map(readRun);
      outputs.push(spill(mergeRecords(group)));
    }
    for (const name of names) removeRun(name);
    return outputs;
  };

  const sweepAll = () => {
    for (const name of [...onDisk]) {
      try {
        fs.rmSync(runPath(name));
      } catch {
        // 收尾出错时尽力把盘清干净，原始错误照抛。
      }
    }
    onDisk.clear();
  };

  function push(item) {
    if (finished) {
      throw new MergeError('ERR_STATE', '排序器已经 finish，不能再 push');
    }
    let serialized;
    try {
      serialized = JSON.stringify(item);
    } catch (cause) {
      throw new MergeError('ERR_BAD_VALUE', '条目没法 JSON 序列化', { cause });
    }
    if (serialized === undefined) {
      throw new MergeError('ERR_BAD_VALUE', '条目没法 JSON 序列化');
    }
    buffer.push({ seq: pushed, item });
    pushed += 1;
    peakBuffered = Math.max(peakBuffered, buffer.length);
    if (buffer.length >= maxInMemory) {
      buffer.sort(ordered);
      spill(buffer);
      buffer = [];
    }
  }

  function finish() {
    if (finished) {
      throw new MergeError('ERR_STATE', '排序器已经 finish，不能再 finish 一次');
    }
    finished = true;

    try {
      let items;
      if (onDisk.size === 0) {
        buffer.sort(ordered);
        items = buffer.map((record) => record.item);
        buffer = [];
        passes = 0;
        return items;
      }

      if (buffer.length > 0) {
        buffer.sort(ordered);
        spill(buffer);
        buffer = [];
      }

      let names = [...onDisk];
      if (names.length === 1) {
        items = readRun(names[0]).map((record) => record.item);
        removeRun(names[0]);
        passes = 0;
        return items;
      }

      let count = 0;
      while (names.length > fanIn) {
        names = mergePass(names);
        count += 1;
      }
      const lists = names.map(readRun);
      items = mergeRecords(lists).map((record) => record.item);
      for (const name of names) removeRun(name);
      passes = count + 1;
      return items;
    } catch (err) {
      sweepAll();
      throw err;
    }
  }

  function stats() {
    return {
      pushed,
      spilled,
      spilledRuns: runCounter,
      peakBuffered,
      passes,
    };
  }

  return { push, finish, stats };
}
