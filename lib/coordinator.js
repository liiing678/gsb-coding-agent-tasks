// 两阶段提交协调器。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/decide.test.js、test/recover.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import { TwopcError } from './errors.js';

export const DEFAULTS = {
  prepareTimeoutMs: 30000,
  retryBackoffMs: 1000,
};

export const MESSAGE_TYPES = ['prepare', 'commit', 'abort'];
export const REPLY_TYPES = ['vote', 'ack'];

function fail(code, message, details) {
  throw new TwopcError(code, message, details);
}

function freshCounts() {
  return {
    begun: 0,
    committed: 0,
    aborted: 0,
    acks: 0,
    duplicates: 0,
    resends: 0,
    recovered: 0,
  };
}

export function createCoordinator(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    fail('ERR_BAD_CONFIG', '配置必须是对象');
  }
  const {
    participants,
    prepareTimeoutMs = DEFAULTS.prepareTimeoutMs,
    retryBackoffMs = DEFAULTS.retryBackoffMs,
    clock = () => Date.now(),
  } = config;
  if (
    !Array.isArray(participants)
    || participants.length === 0
    || participants.some((one) => typeof one !== 'string' || one.length === 0)
    || new Set(participants).size !== participants.length
  ) {
    fail('ERR_BAD_CONFIG', 'participants 必须是不重名的非空字符串数组');
  }
  if (!Number.isInteger(prepareTimeoutMs) || prepareTimeoutMs <= 0) {
    fail('ERR_BAD_CONFIG', 'prepareTimeoutMs 必须是正整数');
  }
  if (!Number.isInteger(retryBackoffMs) || retryBackoffMs <= 0) {
    fail('ERR_BAD_CONFIG', 'retryBackoffMs 必须是正整数');
  }
  if (typeof clock !== 'function') {
    fail('ERR_BAD_CONFIG', 'clock 必须是函数');
  }

  let transactions = new Map();
  let outboxQueue = [];
  let counts = freshCounts();
  let crashed = false;

  // 日志是唯一的持久状态，崩溃不清、恢复靠它。
  const logEntries = [];
  let seq = 0;

  function writeLog(entry) {
    seq += 1;
    logEntries.push({ seq, at: clock(), ...entry });
  }

  function ensureRunning() {
    if (crashed) fail('ERR_BAD_STATE', '协调器已崩溃，先 recover');
  }

  function sortedTransactions() {
    return [...transactions.values()].sort(
      (a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  function decisionMessage(txn, to) {
    return txn.decision === 'commit'
      ? { to, txnId: txn.id, type: 'commit' }
      : { to, txnId: txn.id, type: 'abort', reason: txn.reason };
  }

  // 决定一旦写下就不再变：记 DECISION 日志、发给每个参与者。
  function decide(txn, decision, reason) {
    txn.decision = decision;
    txn.reason = reason;
    txn.state = decision === 'commit' ? 'committing' : 'aborting';
    txn.lastSentAt = clock();
    writeLog({ type: 'DECISION', txnId: txn.id, decision, reason });
    if (decision === 'commit') counts.committed += 1;
    else counts.aborted += 1;
    for (const to of participants) outboxQueue.push(decisionMessage(txn, to));
  }

  function begin(arg) {
    ensureRunning();
    const input = arg !== null && typeof arg === 'object' ? arg : {};
    const { id, ops = [] } = input;
    if (typeof id !== 'string' || id.length === 0) {
      fail('ERR_BAD_TXN', 'id 必须是非空字符串');
    }
    if (!Array.isArray(ops)) fail('ERR_BAD_TXN', 'ops 必须是数组');
    if (transactions.has(id)) fail('ERR_DUPLICATE_TXN', `id 已用过: ${id}`);

    const now = clock();
    const txn = {
      id,
      ops,
      state: 'preparing',
      decision: null,
      reason: null,
      votes: new Map(),
      acked: new Set(),
      startedAt: now,
      lastSentAt: now,
    };
    transactions.set(id, txn);
    counts.begun += 1;
    writeLog({ type: 'BEGIN', txnId: id, ops });
    for (const to of participants) {
      outboxQueue.push({ to, txnId: id, type: 'prepare', ops, attempt: 1 });
    }
    return { id, state: 'preparing', decision: null, deadline: now + prepareTimeoutMs };
  }

  function receiveVote(txn, from, vote) {
    if (vote !== 'yes' && vote !== 'no') {
      fail('ERR_BAD_MESSAGE', "vote 必须是 'yes' 或 'no'");
    }
    if (txn.state !== 'preparing' || txn.votes.has(from)) {
      counts.duplicates += 1;
      return false;
    }
    txn.votes.set(from, vote);
    writeLog({ type: 'VOTE', txnId: txn.id, from, vote });
    if (vote === 'no') {
      decide(txn, 'abort', 'VOTE_NO');
    } else if (participants.every((one) => txn.votes.get(one) === 'yes')) {
      decide(txn, 'commit', null);
    }
    return true;
  }

  function receiveAck(txn, from) {
    if (txn.state === 'preparing') {
      fail('ERR_BAD_MESSAGE', '还没决定就收到 ack');
    }
    if (txn.acked.has(from)) {
      counts.duplicates += 1;
      return false;
    }
    txn.acked.add(from);
    counts.acks += 1;
    writeLog({ type: 'ACK', txnId: txn.id, from });
    if (txn.state !== 'done' && participants.every((one) => txn.acked.has(one))) {
      txn.state = 'done';
      writeLog({ type: 'DONE', txnId: txn.id });
    }
    return true;
  }

  function receive(message) {
    ensureRunning();
    if (message === null || typeof message !== 'object') {
      fail('ERR_BAD_MESSAGE', '消息必须是对象');
    }
    const { from, txnId, type } = message;
    if (!from || !txnId) fail('ERR_BAD_MESSAGE', '消息缺 from 或 txnId');
    if (!participants.includes(from)) {
      fail('ERR_UNKNOWN_PARTICIPANT', `未知参与者: ${from}`);
    }
    const txn = transactions.get(txnId);
    if (!txn) fail('ERR_UNKNOWN_TXN', `未知事务: ${txnId}`);
    if (type === 'vote') return receiveVote(txn, from, message.vote);
    if (type === 'ack') return receiveAck(txn, from);
    fail('ERR_BAD_MESSAGE', `不认识的消息类型: ${type}`);
  }

  function tick() {
    ensureRunning();
    const now = clock();
    const events = [];
    for (const txn of sortedTransactions()) {
      if (txn.state === 'preparing' && now - txn.startedAt >= prepareTimeoutMs) {
        decide(txn, 'abort', 'PREPARE_TIMEOUT');
        events.push({ type: 'abort', txnId: txn.id, reason: 'PREPARE_TIMEOUT' });
      } else if (
        (txn.state === 'committing' || txn.state === 'aborting')
        && now - txn.lastSentAt >= retryBackoffMs
      ) {
        const targets = participants.filter((one) => !txn.acked.has(one));
        if (targets.length === 0) continue;
        for (const to of targets) outboxQueue.push(decisionMessage(txn, to));
        counts.resends += targets.length;
        txn.lastSentAt = now;
        events.push({ type: 'resend', txnId: txn.id, decision: txn.decision, to: targets });
      }
    }
    return events;
  }

  function crash() {
    if (crashed) fail('ERR_BAD_STATE', '已经崩了');
    crashed = true;
    transactions = new Map();
    outboxQueue = [];
    counts = freshCounts();
  }

  function recover() {
    if (!crashed) fail('ERR_BAD_STATE', '没崩过不能 recover');
    transactions = new Map();
    outboxQueue = [];
    counts = freshCounts();

    for (const entry of logEntries) {
      const txn = transactions.get(entry.txnId);
      switch (entry.type) {
        case 'BEGIN':
          transactions.set(entry.txnId, {
            id: entry.txnId,
            ops: entry.ops,
            state: 'preparing',
            decision: null,
            reason: null,
            votes: new Map(),
            acked: new Set(),
            startedAt: entry.at,
            lastSentAt: entry.at,
          });
          counts.begun += 1;
          break;
        case 'VOTE':
          txn.votes.set(entry.from, entry.vote);
          break;
        case 'DECISION':
          txn.decision = entry.decision;
          txn.reason = entry.reason;
          txn.state = entry.decision === 'commit' ? 'committing' : 'aborting';
          txn.lastSentAt = entry.at;
          if (entry.decision === 'commit') counts.committed += 1;
          else counts.aborted += 1;
          break;
        case 'ACK':
          txn.acked.add(entry.from);
          counts.acks += 1;
          break;
        case 'DONE':
          txn.state = 'done';
          break;
        default:
          break;
      }
    }

    const now = clock();
    let taken = 0;
    for (const txn of sortedTransactions()) {
      if (txn.state === 'done') continue;
      if (txn.decision && participants.every((one) => txn.acked.has(one))) {
        txn.state = 'done';
        writeLog({ type: 'DONE', txnId: txn.id });
        continue;
      }
      taken += 1;
      if (!txn.decision) {
        // 没决策过的一律回滚，这是第一条决策，不算重发。
        decide(txn, 'abort', 'RECOVERED');
      } else {
        // 决策不变，只补发没回执的人。
        const targets = participants.filter((one) => !txn.acked.has(one));
        for (const to of targets) outboxQueue.push(decisionMessage(txn, to));
        txn.lastSentAt = now;
        counts.resends += targets.length;
      }
    }
    counts.recovered += 1;
    crashed = false;
    return taken;
  }

  function status(id) {
    const txn = transactions.get(id);
    if (!txn) fail('ERR_UNKNOWN_TXN', `未知事务: ${id}`);
    return {
      id: txn.id,
      state: txn.state,
      decision: txn.decision,
      reason: txn.reason,
      votes: Object.fromEntries(txn.votes),
      acked: participants.filter((one) => txn.acked.has(one)),
      startedAt: txn.startedAt,
      lastSentAt: txn.lastSentAt,
    };
  }

  function pending() {
    return sortedTransactions()
      .filter((txn) => txn.state !== 'done')
      .map((txn) => status(txn.id));
  }

  return {
    begin,
    receive,
    tick,
    crash,
    recover,
    status,
    pending,
    outbox() {
      const out = outboxQueue;
      outboxQueue = [];
      return out;
    },
    log() {
      return logEntries.map((entry) => ({ ...entry }));
    },
    stats() {
      return { ...counts };
    },
  };
}
