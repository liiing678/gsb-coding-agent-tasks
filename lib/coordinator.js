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

const freshStats = () => ({
  begun: 0,
  committed: 0,
  aborted: 0,
  acks: 0,
  duplicates: 0,
  resends: 0,
  recovered: 0,
});

const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

export function createCoordinator(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TwopcError('ERR_BAD_CONFIG', '配置必须是对象');
  }
  const {
    participants,
    prepareTimeoutMs = DEFAULTS.prepareTimeoutMs,
    retryBackoffMs = DEFAULTS.retryBackoffMs,
    clock = () => Date.now(),
  } = config;
  if (
    !Array.isArray(participants) ||
    participants.length === 0 ||
    participants.some((one) => !isNonEmptyString(one)) ||
    new Set(participants).size !== participants.length
  ) {
    throw new TwopcError('ERR_BAD_CONFIG', 'participants 必须是不重名的非空字符串数组');
  }
  if (!isPositiveInteger(prepareTimeoutMs)) {
    throw new TwopcError('ERR_BAD_CONFIG', 'prepareTimeoutMs 必须是正整数');
  }
  if (!isPositiveInteger(retryBackoffMs)) {
    throw new TwopcError('ERR_BAD_CONFIG', 'retryBackoffMs 必须是正整数');
  }
  if (typeof clock !== 'function') {
    throw new TwopcError('ERR_BAD_CONFIG', 'clock 必须是函数');
  }

  // 日志是唯一的持久状态；崩溃只清内存，日志留着。
  const logEntries = [];
  let seq = 0;
  let transactions = new Map();
  let outboxQueue = [];
  let crashed = false;
  let stats = freshStats();

  const appendLog = (type, txnId, extra = {}) => {
    seq += 1;
    logEntries.push({ seq, at: clock(), type, txnId, ...extra });
  };

  const assertAlive = () => {
    if (crashed) {
      throw new TwopcError('ERR_BAD_STATE', '协调器已崩溃，先 recover');
    }
  };

  const sortedPending = () =>
    [...transactions.values()]
      .filter((txn) => txn.state !== 'done')
      .sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const decisionMessage = (txn, to) =>
    txn.decision === 'commit'
      ? { to, txnId: txn.id, type: 'commit' }
      : { to, txnId: txn.id, type: 'abort', reason: txn.reason };

  const enqueueDecision = (txn, recipients = participants) => {
    for (const to of recipients) outboxQueue.push(decisionMessage(txn, to));
  };

  // 决定一旦写进日志就不能再改，恢复时也只认日志。
  const decide = (txn, decision, reason) => {
    txn.decision = decision;
    txn.reason = reason;
    txn.state = decision === 'commit' ? 'committing' : 'aborting';
    txn.lastSentAt = clock();
    appendLog('DECISION', txn.id, { decision, reason });
    if (decision === 'commit') stats.committed += 1;
    else stats.aborted += 1;
    enqueueDecision(txn);
  };

  const begin = (input = {}) => {
    assertAlive();
    const { id, ops = [] } = input;
    if (!isNonEmptyString(id)) {
      throw new TwopcError('ERR_BAD_TXN', 'id 必须是非空字符串');
    }
    if (!Array.isArray(ops)) {
      throw new TwopcError('ERR_BAD_TXN', 'ops 必须是数组');
    }
    if (transactions.has(id)) {
      throw new TwopcError('ERR_DUPLICATE_TXN', `事务 ${id} 已经用过`, { txnId: id });
    }
    const startedAt = clock();
    const txn = {
      id,
      ops,
      state: 'preparing',
      decision: null,
      reason: null,
      votes: new Map(),
      acked: new Set(),
      startedAt,
      lastSentAt: startedAt,
    };
    transactions.set(id, txn);
    appendLog('BEGIN', id);
    for (const to of participants) {
      outboxQueue.push({ to, txnId: id, type: 'prepare', ops, attempt: 1 });
    }
    stats.begun += 1;
    return { id, state: 'preparing', decision: null, deadline: startedAt + prepareTimeoutMs };
  };

  const receiveVote = (txn, message) => {
    const { from, vote } = message;
    if (vote !== 'yes' && vote !== 'no') {
      throw new TwopcError('ERR_BAD_MESSAGE', 'vote 只能是 yes 或 no');
    }
    // 已决定或已投过：只是重复投递，不改票也不改状态。
    if (txn.state !== 'preparing' || txn.votes.has(from)) {
      stats.duplicates += 1;
      return false;
    }
    txn.votes.set(from, vote);
    appendLog('VOTE', txn.id, { from, vote });
    if (vote === 'no') {
      decide(txn, 'abort', 'VOTE_NO');
    } else if (participants.every((one) => txn.votes.get(one) === 'yes')) {
      decide(txn, 'commit', null);
    }
    return true;
  };

  const receiveAck = (txn, message) => {
    const { from } = message;
    if (txn.state !== 'committing' && txn.state !== 'aborting') {
      throw new TwopcError('ERR_BAD_MESSAGE', '还没决定就收到 ack');
    }
    if (txn.acked.has(from)) {
      stats.duplicates += 1;
      return false;
    }
    txn.acked.add(from);
    appendLog('ACK', txn.id, { from });
    stats.acks += 1;
    if (participants.every((one) => txn.acked.has(one))) {
      txn.state = 'done';
      appendLog('DONE', txn.id);
    }
    return true;
  };

  const receive = (message) => {
    assertAlive();
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      throw new TwopcError('ERR_BAD_MESSAGE', '消息必须是对象');
    }
    const { from, txnId, type } = message;
    if (!isNonEmptyString(from) || !isNonEmptyString(txnId)) {
      throw new TwopcError('ERR_BAD_MESSAGE', '消息缺 from 或 txnId');
    }
    if (!participants.includes(from)) {
      throw new TwopcError('ERR_UNKNOWN_PARTICIPANT', `不认识参与者 ${from}`, { from });
    }
    const txn = transactions.get(txnId);
    if (!txn) {
      throw new TwopcError('ERR_UNKNOWN_TXN', `没见过事务 ${txnId}`, { txnId });
    }
    if (type === 'vote') return receiveVote(txn, message);
    if (type === 'ack') return receiveAck(txn, message);
    throw new TwopcError('ERR_BAD_MESSAGE', `不认识的消息类型 ${type}`);
  };

  const tick = () => {
    assertAlive();
    const now = clock();
    const events = [];
    for (const txn of sortedPending()) {
      if (txn.state === 'preparing') {
        if (now - txn.startedAt >= prepareTimeoutMs) {
          decide(txn, 'abort', 'PREPARE_TIMEOUT');
          events.push({ type: 'abort', txnId: txn.id, reason: 'PREPARE_TIMEOUT' });
        }
      } else if (now - txn.lastSentAt >= retryBackoffMs) {
        const missing = participants.filter((one) => !txn.acked.has(one));
        if (missing.length > 0) {
          enqueueDecision(txn, missing);
          txn.lastSentAt = now;
          stats.resends += missing.length;
          events.push({ type: 'resend', txnId: txn.id, decision: txn.decision, to: missing });
        }
      }
    }
    return events;
  };

  const crash = () => {
    if (crashed) {
      throw new TwopcError('ERR_BAD_STATE', '已经处于崩溃状态');
    }
    crashed = true;
    transactions = new Map();
    outboxQueue = [];
    stats = freshStats();
  };

  const recover = () => {
    if (!crashed) {
      throw new TwopcError('ERR_BAD_STATE', '没有崩溃，不能恢复');
    }
    transactions = new Map();
    outboxQueue = [];
    stats = freshStats();
    for (const entry of logEntries) {
      if (entry.type === 'BEGIN') {
        transactions.set(entry.txnId, {
          id: entry.txnId,
          ops: [],
          state: 'preparing',
          decision: null,
          reason: null,
          votes: new Map(),
          acked: new Set(),
          startedAt: entry.at,
          lastSentAt: entry.at,
        });
        stats.begun += 1;
      } else if (entry.type === 'VOTE') {
        transactions.get(entry.txnId).votes.set(entry.from, entry.vote);
      } else if (entry.type === 'DECISION') {
        const txn = transactions.get(entry.txnId);
        txn.decision = entry.decision;
        txn.reason = entry.reason;
        txn.state = entry.decision === 'commit' ? 'committing' : 'aborting';
        if (entry.decision === 'commit') stats.committed += 1;
        else stats.aborted += 1;
      } else if (entry.type === 'ACK') {
        transactions.get(entry.txnId).acked.add(entry.from);
        stats.acks += 1;
      } else if (entry.type === 'DONE') {
        transactions.get(entry.txnId).state = 'done';
      }
    }
    crashed = false;
    stats.recovered += 1;
    const now = clock();
    let taken = 0;
    for (const txn of sortedPending()) {
      taken += 1;
      txn.lastSentAt = now;
      if (txn.decision === null) {
        // 没决策的一律回滚；这是第一条决策，不算重发。
        decide(txn, 'abort', 'RECOVERED');
      } else {
        // 决策不变，只补发没回执的人。
        const missing = participants.filter((one) => !txn.acked.has(one));
        enqueueDecision(txn, missing);
        stats.resends += missing.length;
      }
    }
    return taken;
  };

  const status = (id) => {
    const txn = transactions.get(id);
    if (!txn) {
      throw new TwopcError('ERR_UNKNOWN_TXN', `没见过事务 ${id}`, { txnId: id });
    }
    const votes = {};
    for (const [who, vote] of txn.votes) votes[who] = vote;
    return {
      id: txn.id,
      state: txn.state,
      decision: txn.decision,
      reason: txn.reason,
      votes,
      acked: participants.filter((one) => txn.acked.has(one)),
      startedAt: txn.startedAt,
      lastSentAt: txn.lastSentAt,
    };
  };

  return {
    begin,
    receive,
    tick,
    crash,
    recover,
    status,
    outbox: () => {
      const out = outboxQueue;
      outboxQueue = [];
      return out;
    },
    pending: () => sortedPending().map((txn) => status(txn.id)),
    log: () => logEntries.map((entry) => ({ ...entry })),
    stats: () => ({ ...stats }),
  };
}
