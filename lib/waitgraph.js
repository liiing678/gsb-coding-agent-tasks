// 事务等待图与死锁检测。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/wait.test.js、test/detect.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import { WaitError } from './errors.js';

export const DEFAULTS = {
  maxWaitMs: 1000,
};

export function createDeadlockDetector(config = {}) {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new WaitError('ERR_BAD_CONFIG', 'config 必须是对象');
  }

  const clock = config.clock === undefined ? Date.now : config.clock;
  if (typeof clock !== 'function') {
    throw new WaitError('ERR_BAD_CONFIG', 'clock 必须是函数');
  }

  const maxWaitMs = config.maxWaitMs === undefined
    ? DEFAULTS.maxWaitMs
    : config.maxWaitMs;
  if (!isPositiveInteger(maxWaitMs)) {
    throw new WaitError('ERR_BAD_CONFIG', 'maxWaitMs 必须是正整数');
  }

  const readClock = () => {
    const now = clock();
    if (!Number.isFinite(now)) {
      throw new WaitError('ERR_BAD_CONFIG', 'clock 必须返回有限数');
    }
    return now;
  };
  readClock();

  const transactions = new Map();
  const resources = new Map();
  const counters = {
    grants: 0,
    releases: 0,
    cycles: 0,
    aborts: 0,
    timeouts: 0,
  };

  function fail(code, message) {
    throw new WaitError(code, message);
  }

  function requireObject(args) {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      fail('ERR_BAD_ARGS', '参数必须是对象');
    }
  }

  function grant(tx, resource) {
    resource.holder = tx.txId;
    tx.holds.add(resource.resource);
    counters.grants += 1;
  }

  function handOff(tx, resource, countedRelease) {
    resource.holder = null;
    tx.holds.delete(resource.resource);
    if (countedRelease) {
      counters.releases += 1;
    }

    const nextId = resource.waiters.shift();
    if (nextId !== undefined) {
      grant(transactions.get(nextId), resource);
      transactions.get(nextId).waiting = null;
    }
  }

  function abort(tx, timedOut) {
    tx.aborted = true;

    if (tx.waiting !== null) {
      const resource = resources.get(tx.waiting.resource);
      if (resource !== undefined) {
        resource.waiters = resource.waiters.filter((id) => id !== tx.txId);
      }
      tx.waiting = null;
    }

    for (const resourceName of [...tx.holds].sort()) {
      const resource = resources.get(resourceName);
      handOff(tx, resource, false);
    }

    counters.aborts += 1;
    if (timedOut) {
      counters.timeouts += 1;
    }
  }

  function register(args = {}) {
    requireObject(args);
    const { txId, startedAt } = args;
    if (!isNonEmptyString(txId)) {
      fail('ERR_BAD_ARGS', 'txId 必须是非空字符串');
    }

    let actualStartedAt;
    if (startedAt === undefined) {
      actualStartedAt = readClock();
    } else if (!Number.isFinite(startedAt)) {
      fail('ERR_BAD_ARGS', 'startedAt 必须是有限数');
    } else {
      actualStartedAt = startedAt;
    }

    if (transactions.has(txId)) {
      fail('ERR_DUPLICATE_TX', `事务 ${txId} 已经登记过`);
    }

    transactions.set(txId, {
      txId,
      startedAt: actualStartedAt,
      holds: new Set(),
      waiting: null,
      aborted: false,
    });
  }

  function wait(args = {}) {
    requireObject(args);
    const { txId, resource: resourceName } = args;
    const timeout = args.timeoutMs === undefined ? maxWaitMs : args.timeoutMs;
    if (!isNonEmptyString(txId) || !isNonEmptyString(resourceName)) {
      fail('ERR_BAD_ARGS', 'txId 和 resource 必须是非空字符串');
    }
    if (!isPositiveInteger(timeout)) {
      fail('ERR_BAD_ARGS', 'timeoutMs 必须是正整数');
    }

    const tx = transactions.get(txId);
    if (tx === undefined) {
      fail('ERR_UNKNOWN_TX', `事务 ${txId} 没有登记过`);
    }
    if (tx.aborted) {
      fail('ERR_TX_ABORTED', `事务 ${txId} 已经作废`);
    }
    if (tx.waiting !== null) {
      fail('ERR_ALREADY_WAITING', `事务 ${txId} 已经在等待资源`);
    }

    let resource = resources.get(resourceName);
    if (resource !== undefined && resource.holder === txId) {
      fail('ERR_ALREADY_HOLDER', `事务 ${txId} 已经持有 ${resourceName}`);
    }
    if (resource === undefined) {
      resource = { resource: resourceName, holder: null, waiters: [] };
      resources.set(resourceName, resource);
    }

    if (resource.holder === null) {
      grant(tx, resource);
      return { txId, resource: resourceName, granted: true, waitingFor: null };
    }

    resource.waiters.push(txId);
    tx.waiting = {
      resource: resourceName,
      waitedAt: readClock(),
      timeoutMs: timeout,
    };
    return {
      txId,
      resource: resourceName,
      granted: false,
      waitingFor: resource.holder,
    };
  }

  function release(args = {}) {
    requireObject(args);
    const { txId, resource: resourceName } = args;
    if (!isNonEmptyString(txId) || !isNonEmptyString(resourceName)) {
      fail('ERR_BAD_ARGS', 'txId 和 resource 必须是非空字符串');
    }

    const tx = transactions.get(txId);
    if (tx === undefined) {
      fail('ERR_UNKNOWN_TX', `事务 ${txId} 没有登记过`);
    }
    if (tx.aborted) {
      fail('ERR_TX_ABORTED', `事务 ${txId} 已经作废`);
    }

    const resource = resources.get(resourceName);
    if (resource === undefined) {
      fail('ERR_UNKNOWN_RESOURCE', `资源 ${resourceName} 从来没有出现过`);
    }
    if (resource.holder !== txId) {
      fail('ERR_NOT_HOLDER', `事务 ${txId} 没有持有 ${resourceName}`);
    }

    handOff(tx, resource, true);
    return {
      txId,
      resource: resourceName,
      released: true,
      grantedTo: resource.holder,
    };
  }

  function detect() {
    const now = readClock();
    const timeouts = [];
    const victims = [];

    const timedOut = [...transactions.values()]
      .filter((tx) => (
        !tx.aborted
        && tx.waiting !== null
        && now - tx.waiting.waitedAt > tx.waiting.timeoutMs
      ))
      .sort((left, right) => (
        left.waiting.waitedAt - right.waiting.waitedAt
        || compareText(left.txId, right.txId)
      ));

    for (const tx of timedOut) {
      if (
        tx.aborted
        || tx.waiting === null
        || now - tx.waiting.waitedAt <= tx.waiting.timeoutMs
      ) {
        continue;
      }
      abort(tx, true);
      timeouts.push(tx.txId);
      victims.push(tx.txId);
    }

    const edges = new Map();
    for (const tx of transactions.values()) {
      if (tx.aborted || tx.waiting === null) {
        continue;
      }
      const resource = resources.get(tx.waiting.resource);
      const holder = resource === undefined ? null : resource.holder;
      if (holder !== null && !transactions.get(holder).aborted) {
        edges.set(tx.txId, holder);
      }
    }

    const visited = new Set();
    const cycles = [];
    for (const startId of [...transactions.keys()].sort(compareText)) {
      if (visited.has(startId) || transactions.get(startId).aborted) {
        continue;
      }

      const path = [];
      const positions = new Map();
      let current = startId;
      let foundCycle = null;

      while (current !== undefined && current !== null) {
        if (visited.has(current)) {
          break;
        }
        if (positions.has(current)) {
          foundCycle = path.slice(positions.get(current));
          break;
        }
        positions.set(current, path.length);
        path.push(current);
        current = edges.get(current);
      }

      for (const id of path) {
        visited.add(id);
      }
      if (foundCycle !== null) {
        cycles.push(normalizeCycle(foundCycle));
      }
    }

    cycles.sort((left, right) => compareText(left[0], right[0]));
    counters.cycles += cycles.length;

    for (const cycle of cycles) {
      const victimId = chooseVictim(cycle);
      abort(transactions.get(victimId), false);
      victims.push(victimId);
    }

    return { cycles, victims, timeouts };
  }

  function normalizeCycle(cycle) {
    let smallestIndex = 0;
    for (let index = 1; index < cycle.length; index += 1) {
      if (cycle[index] < cycle[smallestIndex]) {
        smallestIndex = index;
      }
    }
    return cycle.slice(smallestIndex).concat(cycle.slice(0, smallestIndex));
  }

  function chooseVictim(cycle) {
    return cycle.reduce((victimId, candidateId) => {
      if (victimId === null) {
        return candidateId;
      }
      const victim = transactions.get(victimId);
      const candidate = transactions.get(candidateId);
      if (
        candidate.startedAt > victim.startedAt
        || (candidate.startedAt === victim.startedAt && candidateId > victimId)
      ) {
        return candidateId;
      }
      return victimId;
    }, null);
  }

  function snapshot() {
    return {
      transactions: [...transactions.keys()].sort(compareText).map((txId) => {
        const tx = transactions.get(txId);
        const resourceName = tx.waiting === null ? null : tx.waiting.resource;
        const resource = resourceName === null ? null : resources.get(resourceName);
        return {
          txId,
          startedAt: tx.startedAt,
          holds: [...tx.holds].sort(compareText),
          waitingFor: resource === null || resource === undefined ? null : resource.holder,
          resource: resourceName,
          aborted: tx.aborted,
        };
      }),
      resources: [...resources.keys()].sort(compareText).map((resourceName) => {
        const resource = resources.get(resourceName);
        return {
          resource: resourceName,
          holder: resource.holder,
          waiters: [...resource.waiters],
        };
      }),
    };
  }

  function stats() {
    return {
      transactions: transactions.size,
      held: [...resources.values()].filter((resource) => resource.holder !== null).length,
      waiting: [...transactions.values()].filter((tx) => tx.waiting !== null).length,
      grants: counters.grants,
      releases: counters.releases,
      cycles: counters.cycles,
      aborts: counters.aborts,
      timeouts: counters.timeouts,
    };
  }

  return {
    register,
    wait,
    release,
    detect,
    snapshot,
    stats,
  };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function compareText(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
