// 事务等待图与死锁检测。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/wait.test.js、test/detect.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import { WaitError } from './errors.js';

export const DEFAULTS = {
  maxWaitMs: 1000,
};

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const cmpString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function fail(code, message, details = {}) {
  throw new WaitError(code, message, details);
}

export function createDeadlockDetector(config = {}) {
  if (config === null || typeof config !== 'object') {
    fail('ERR_BAD_CONFIG', 'config 必须是对象');
  }
  const clock = config.clock === undefined ? Date.now : config.clock;
  if (typeof clock !== 'function') {
    fail('ERR_BAD_CONFIG', 'clock 必须是函数');
  }
  const maxWaitMs = config.maxWaitMs === undefined ? DEFAULTS.maxWaitMs : config.maxWaitMs;
  if (!isPositiveInteger(maxWaitMs)) {
    fail('ERR_BAD_CONFIG', 'maxWaitMs 必须是正整数');
  }
  if (!isFiniteNumber(clock())) {
    fail('ERR_BAD_CONFIG', 'clock 必须返回有限数');
  }

  const transactions = new Map();
  const resources = new Map();
  const counters = { grants: 0, releases: 0, cycles: 0, aborts: 0, timeouts: 0 };

  function requireTx(args) {
    if (args === null || typeof args !== 'object' || !isNonEmptyString(args.txId)) {
      fail('ERR_BAD_ARGS', 'txId 必须是非空字符串');
    }
    const tx = transactions.get(args.txId);
    if (!tx) {
      fail('ERR_UNKNOWN_TX', `事务 ${args.txId} 没登记过`, { txId: args.txId });
    }
    return tx;
  }

  // 资源空出来时按 FIFO 交给队首；拿到资源的事务同时清掉等待边。
  function handoff(res) {
    const nextId = res.waiters.shift();
    if (nextId === undefined) {
      return null;
    }
    const next = transactions.get(nextId);
    res.holder = nextId;
    next.holds.add(res.resource);
    next.waiting = null;
    counters.grants += 1;
    return nextId;
  }

  // 作废：清等待边，持有的资源逐条按 FIFO 交接。
  function abort(tx, timedOut) {
    tx.aborted = true;
    if (tx.waiting) {
      const waited = resources.get(tx.waiting.resource);
      const index = waited.waiters.indexOf(tx.txId);
      if (index !== -1) {
        waited.waiters.splice(index, 1);
      }
      tx.waiting = null;
    }
    for (const resource of [...tx.holds]) {
      const res = resources.get(resource);
      res.holder = null;
      tx.holds.delete(resource);
      handoff(res);
    }
    counters.aborts += 1;
    if (timedOut) {
      counters.timeouts += 1;
    }
  }

  function register({ txId, startedAt } = {}) {
    if (!isNonEmptyString(txId)) {
      fail('ERR_BAD_ARGS', 'txId 必须是非空字符串');
    }
    if (startedAt !== undefined && !isFiniteNumber(startedAt)) {
      fail('ERR_BAD_ARGS', 'startedAt 必须是有限数', { txId, startedAt });
    }
    if (transactions.has(txId)) {
      fail('ERR_DUPLICATE_TX', `事务 ${txId} 已经登记过`, { txId });
    }
    transactions.set(txId, {
      txId,
      startedAt: startedAt === undefined ? clock() : startedAt,
      holds: new Set(),
      waiting: null,
      aborted: false,
    });
  }

  function wait({ txId, resource, timeoutMs } = {}) {
    if (!isNonEmptyString(txId) || !isNonEmptyString(resource)) {
      fail('ERR_BAD_ARGS', 'txId / resource 必须是非空字符串', { txId, resource });
    }
    if (timeoutMs !== undefined && !isPositiveInteger(timeoutMs)) {
      fail('ERR_BAD_ARGS', 'timeoutMs 必须是正整数', { txId, timeoutMs });
    }
    const tx = requireTx({ txId });
    if (tx.aborted) {
      fail('ERR_TX_ABORTED', `事务 ${txId} 已经作废`, { txId });
    }
    let res = resources.get(resource);
    if (tx.waiting) {
      fail('ERR_ALREADY_WAITING', `事务 ${txId} 已经在等 ${tx.waiting.resource}`, {
        txId,
        resource: tx.waiting.resource,
      });
    }
    if (res && res.holder === txId) {
      fail('ERR_ALREADY_HOLDER', `事务 ${txId} 已经持有 ${resource}`, { txId, resource });
    }
    if (!res) {
      res = { resource, holder: null, waiters: [] };
      resources.set(resource, res);
    }
    if (res.holder === null) {
      res.holder = txId;
      tx.holds.add(resource);
      counters.grants += 1;
      return { txId, resource, granted: true, waitingFor: null };
    }
    tx.waiting = {
      resource,
      waitedAt: clock(),
      timeoutMs: timeoutMs === undefined ? maxWaitMs : timeoutMs,
    };
    res.waiters.push(txId);
    return { txId, resource, granted: false, waitingFor: res.holder };
  }

  function release({ txId, resource } = {}) {
    if (!isNonEmptyString(txId) || !isNonEmptyString(resource)) {
      fail('ERR_BAD_ARGS', 'txId / resource 必须是非空字符串', { txId, resource });
    }
    const tx = requireTx({ txId });
    if (tx.aborted) {
      fail('ERR_TX_ABORTED', `事务 ${txId} 已经作废`, { txId });
    }
    const res = resources.get(resource);
    if (!res) {
      fail('ERR_UNKNOWN_RESOURCE', `资源 ${resource} 从来没出现过`, { resource });
    }
    if (res.holder !== txId) {
      fail('ERR_NOT_HOLDER', `事务 ${txId} 没持有 ${resource}`, { txId, resource });
    }
    res.holder = null;
    tx.holds.delete(resource);
    counters.releases += 1;
    const grantedTo = handoff(res);
    return { txId, resource, released: true, grantedTo };
  }

  function detect() {
    const now = clock();

    // 先处理超时：严格大于才算；按 waitedAt、再按 txId 升序依次作废。
    const expired = [...transactions.values()]
      .filter((tx) => !tx.aborted && tx.waiting !== null
        && now - tx.waiting.waitedAt > tx.waiting.timeoutMs)
      .sort((a, b) => (a.waiting.waitedAt - b.waiting.waitedAt) || cmpString(a.txId, b.txId));
    const timeouts = [];
    const victims = [];
    for (const tx of expired) {
      if (!tx.aborted && tx.waiting !== null) {
        abort(tx, true);
        timeouts.push(tx.txId);
        victims.push(tx.txId);
      }
    }

    // 再看环：每个事务至多一条出边，环互不相交。
    const edge = new Map();
    for (const tx of transactions.values()) {
      if (tx.aborted || tx.waiting === null) {
        continue;
      }
      const holder = resources.get(tx.waiting.resource).holder;
      if (holder !== null) {
        edge.set(tx.txId, holder);
      }
    }
    const cycles = [];
    const seen = new Set();
    for (const start of [...transactions.keys()].sort(cmpString)) {
      if (seen.has(start)) {
        continue;
      }
      const path = [];
      const indexAt = new Map();
      let cur = start;
      while (cur !== undefined && !seen.has(cur) && !indexAt.has(cur)) {
        indexAt.set(cur, path.length);
        path.push(cur);
        cur = edge.get(cur);
      }
      if (cur !== undefined && indexAt.has(cur)) {
        const cycle = path.slice(indexAt.get(cur));
        let minIndex = 0;
        for (let i = 1; i < cycle.length; i += 1) {
          if (cycle[i] < cycle[minIndex]) {
            minIndex = i;
          }
        }
        cycles.push([...cycle.slice(minIndex), ...cycle.slice(0, minIndex)]);
      }
      for (const node of path) {
        seen.add(node);
      }
    }
    cycles.sort((a, b) => cmpString(a[0], b[0]));

    for (const cycle of cycles) {
      let victim = cycle[0];
      for (const id of cycle.slice(1)) {
        const candidate = transactions.get(id);
        const current = transactions.get(victim);
        if (candidate.startedAt > current.startedAt
          || (candidate.startedAt === current.startedAt && id > victim)) {
          victim = id;
        }
      }
      abort(transactions.get(victim), false);
      victims.push(victim);
    }
    counters.cycles += cycles.length;

    return { cycles, victims, timeouts };
  }

  function snapshot() {
    const txRows = [...transactions.values()].sort((a, b) => cmpString(a.txId, b.txId))
      .map((tx) => ({
        txId: tx.txId,
        startedAt: tx.startedAt,
        holds: [...tx.holds].sort(cmpString),
        waitingFor: tx.waiting ? resources.get(tx.waiting.resource).holder : null,
        resource: tx.waiting ? tx.waiting.resource : null,
        aborted: tx.aborted,
      }));
    const resourceRows = [...resources.values()].sort((a, b) => cmpString(a.resource, b.resource))
      .map((res) => ({ resource: res.resource, holder: res.holder, waiters: [...res.waiters] }));
    return { transactions: txRows, resources: resourceRows };
  }

  function stats() {
    let held = 0;
    let waiting = 0;
    for (const res of resources.values()) {
      if (res.holder !== null) {
        held += 1;
      }
    }
    for (const tx of transactions.values()) {
      if (tx.waiting !== null) {
        waiting += 1;
      }
    }
    return {
      transactions: transactions.size,
      held,
      waiting,
      grants: counters.grants,
      releases: counters.releases,
      cycles: counters.cycles,
      aborts: counters.aborts,
      timeouts: counters.timeouts,
    };
  }

  return { register, wait, release, detect, snapshot, stats };
}
