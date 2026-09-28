import { RaftlogError } from './errors.js';

const error = (code, message) => new RaftlogError(code, message);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidMembers(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every(isNonEmptyString)
    && new Set(value).size === value.length;
}

function isValidEntry(value) {
  return isObject(value)
    && isNonNegativeInteger(value.term)
    && Object.prototype.hasOwnProperty.call(value, 'command');
}

function copyEntry(entry) {
  return { term: entry.term, command: entry.command };
}

function isConfigCommand(command) {
  return isObject(command) && Object.prototype.hasOwnProperty.call(command, 'config');
}

export function createNode(options = {}) {
  if (!isObject(options)) {
    throw error('ERR_BAD_CONFIG', '节点配置必须是对象');
  }

  const {
    id,
    members: initialMembers,
    term: initialTerm = 0,
    leader = false,
    snapshot: initialSnapshot = { index: 0, term: 0 },
    entries: initialEntries = [],
  } = options;

  if (!isNonEmptyString(id)) {
    throw error('ERR_BAD_CONFIG', 'id 必须是非空字符串');
  }
  if (!isValidMembers(initialMembers) || !initialMembers.includes(id)) {
    throw error('ERR_BAD_CONFIG', 'members 必须包含本节点且成员不重复');
  }
  if (!isNonNegativeInteger(initialTerm)) {
    throw error('ERR_BAD_CONFIG', 'term 必须是非负整数');
  }
  if (
    !isObject(initialSnapshot)
    || !isNonNegativeInteger(initialSnapshot.index)
    || !isNonNegativeInteger(initialSnapshot.term)
  ) {
    throw error('ERR_BAD_CONFIG', 'snapshot 形状不合法');
  }
  if (!Array.isArray(initialEntries) || !initialEntries.every(isValidEntry)) {
    throw error('ERR_BAD_CONFIG', 'entries 形状不合法');
  }

  let currentTerm = initialTerm;
  let members = [...initialMembers];
  let snapshot = { index: initialSnapshot.index, term: initialSnapshot.term };
  let log = initialEntries.map(copyEntry);
  let commitIndex = snapshot.index;
  let leaderId = null;
  let isLeader = Boolean(leader);
  let matchIndex = null;
  let nextIndex = null;
  let pendingSnapshots = null;

  function lastIndex() {
    return snapshot.index + log.length;
  }

  function lastTerm() {
    return log.length > 0 ? log[log.length - 1].term : snapshot.term;
  }

  function termAt(index) {
    if (!isNonNegativeInteger(index) || index < snapshot.index || index > lastIndex()) {
      throw error('ERR_LOG_MISSING', `日志下标 ${index} 不存在`);
    }
    if (index === snapshot.index) {
      return snapshot.term;
    }
    return log[index - snapshot.index - 1].term;
  }

  function commandAt(index) {
    if (!isNonNegativeInteger(index) || index <= snapshot.index || index > lastIndex()) {
      throw error('ERR_LOG_MISSING', `日志下标 ${index} 的命令不存在`);
    }
    return log[index - snapshot.index - 1].command;
  }

  function initializeLeaderTracking() {
    matchIndex = new Map();
    nextIndex = new Map();
    pendingSnapshots = new Set();
    for (const member of members) {
      if (member !== id) {
        matchIndex.set(member, 0);
        nextIndex.set(member, lastIndex() + 1);
      }
    }
  }

  if (isLeader) {
    initializeLeaderTracking();
  }

  function assertLeader() {
    if (!isLeader) {
      throw error('ERR_NOT_LEADER', '当前节点不是 leader');
    }
  }

  function applyConfig(nextMembers) {
    if (!isValidMembers(nextMembers)) {
      throw error('ERR_BAD_CONFIG', '配置成员表不合法');
    }

    if (isLeader) {
      const oldMembers = new Set(members);
      for (const member of nextMembers) {
        if (!oldMembers.has(member)) {
          matchIndex.set(member, 0);
          nextIndex.set(member, lastIndex() + 1);
        }
      }
      for (const member of members) {
        if (!nextMembers.includes(member)) {
          matchIndex.delete(member);
          nextIndex.delete(member);
          pendingSnapshots.delete(member);
        }
      }
    }

    members = [...nextMembers];
  }

  function applyCommittedConfigs(fromIndex, throughIndex) {
    for (let index = fromIndex; index <= throughIndex; index += 1) {
      const command = commandAt(index);
      if (isConfigCommand(command)) {
        applyConfig(command.config);
      }
    }
  }

  function advanceCommitIndex() {
    const reported = members.map((member) => (
      member === id ? lastIndex() : (matchIndex.get(member) ?? 0)
    ));
    reported.sort((left, right) => right - left);
    const candidate = reported[Math.floor(reported.length / 2)];

    if (
      candidate > commitIndex
      && candidate <= lastIndex()
      && termAt(candidate) === currentTerm
    ) {
      const previousCommit = commitIndex;
      commitIndex = candidate;
      applyCommittedConfigs(previousCommit + 1, candidate);
    }
  }

  function adoptTerm(messageTerm) {
    if (messageTerm > currentTerm) {
      if (isLeader) {
        isLeader = false;
        leaderId = null;
        matchIndex = null;
        nextIndex = null;
        pendingSnapshots = null;
      }
      currentTerm = messageTerm;
    }
  }

  function appendFailure(message, conflictIndex) {
    return {
      type: 'appendResponse',
      from: id,
      to: message.from,
      term: currentTerm,
      success: false,
      conflictIndex,
    };
  }

  function appendSuccess(message, matchedIndex) {
    return {
      type: 'appendResponse',
      from: id,
      to: message.from,
      term: currentTerm,
      success: true,
      matchIndex: matchedIndex,
    };
  }

  function handleAppend(message) {
    if (message.term < currentTerm) {
      return [appendFailure(message, lastIndex() + 1)];
    }

    adoptTerm(message.term);
    leaderId = message.from;

    const { prevIndex, prevTerm, entries, leaderCommit } = message;

    if (prevIndex < snapshot.index) {
      return [appendFailure(message, snapshot.index + 1)];
    }
    if (prevIndex === snapshot.index) {
      if (prevTerm !== snapshot.term) {
        return [appendFailure(message, 0)];
      }
    } else if (prevIndex > lastIndex()) {
      return [appendFailure(message, lastIndex() + 1)];
    } else if (termAt(prevIndex) !== prevTerm) {
      const conflictingTerm = termAt(prevIndex);
      const firstOffset = log.findIndex((entry) => entry.term === conflictingTerm);
      return [appendFailure(message, snapshot.index + firstOffset + 1)];
    }

    const startOffset = prevIndex - snapshot.index;
    for (let offset = 0; offset < entries.length; offset += 1) {
      const localOffset = startOffset + offset;
      if (localOffset >= log.length || log[localOffset].term !== entries[offset].term) {
        log = [
          ...log.slice(0, localOffset),
          ...entries.slice(offset).map(copyEntry),
        ];
        break;
      }
    }

    const nextCommitIndex = Math.min(leaderCommit, lastIndex());
    if (nextCommitIndex > commitIndex) {
      const previousCommit = commitIndex;
      commitIndex = nextCommitIndex;
      applyCommittedConfigs(previousCommit + 1, nextCommitIndex);
    }

    return [appendSuccess(message, prevIndex + entries.length)];
  }

  function handleAppendResponse(message) {
    if (message.term < currentTerm || !isLeader) {
      return [];
    }

    adoptTerm(message.term);
    if (!isLeader || !nextIndex.has(message.from)) {
      return [];
    }

    if (message.success) {
      if (message.matchIndex > matchIndex.get(message.from)) {
        matchIndex.set(message.from, message.matchIndex);
      }
      nextIndex.set(
        message.from,
        Math.max(nextIndex.get(message.from), message.matchIndex + 1),
      );
    } else {
      nextIndex.set(message.from, Math.max(1, message.conflictIndex));
    }

    const next = nextIndex.get(message.from);
    if (next <= snapshot.index) {
      pendingSnapshots.add(message.from);
    } else {
      pendingSnapshots.delete(message.from);
    }

    advanceCommitIndex();
    return [];
  }

  function snapshotResponse(message, success, matchedIndex) {
    return {
      type: 'snapshotResponse',
      from: id,
      to: message.from,
      term: currentTerm,
      success,
      matchIndex: matchedIndex,
    };
  }

  function handleSnapshot(message) {
    if (message.term < currentTerm) {
      return [snapshotResponse(message, false, 0)];
    }

    adoptTerm(message.term);
    leaderId = message.from;

    const { lastIncludedIndex, lastIncludedTerm } = message;
    if (lastIncludedIndex <= commitIndex) {
      return [snapshotResponse(message, true, lastIncludedIndex)];
    }

    if (
      lastIncludedIndex <= lastIndex()
      && termAt(lastIncludedIndex) === lastIncludedTerm
    ) {
      log = log.slice(lastIncludedIndex - snapshot.index);
    } else {
      log = [];
    }

    snapshot = { index: lastIncludedIndex, term: lastIncludedTerm };
    commitIndex = Math.max(commitIndex, lastIncludedIndex);
    if (message.members !== undefined) {
      applyConfig(message.members);
    }

    return [snapshotResponse(message, true, lastIncludedIndex)];
  }

  function handleSnapshotResponse(message) {
    if (message.term < currentTerm || !isLeader) {
      return [];
    }

    adoptTerm(message.term);
    if (!isLeader || !message.success || !nextIndex.has(message.from)) {
      return [];
    }

    if (message.matchIndex > matchIndex.get(message.from)) {
      matchIndex.set(message.from, message.matchIndex);
    }
    const next = Math.max(nextIndex.get(message.from), message.matchIndex + 1);
    nextIndex.set(message.from, next);
    if (next <= snapshot.index) {
      pendingSnapshots.add(message.from);
    } else {
      pendingSnapshots.delete(message.from);
    }

    advanceCommitIndex();
    return [];
  }

  function validateMessage(message) {
    if (!isObject(message)) {
      throw error('ERR_BAD_MESSAGE', '消息必须是对象');
    }
    if (!isNonEmptyString(message.from) || !isNonEmptyString(message.to)) {
      throw error('ERR_BAD_MESSAGE', '消息的 from / to 必须是非空字符串');
    }
    if (!isNonNegativeInteger(message.term)) {
      throw error('ERR_BAD_MESSAGE', '消息的 term 必须是非负整数');
    }

    if (message.type === 'append') {
      if (
        !isNonNegativeInteger(message.prevIndex)
        || !isNonNegativeInteger(message.prevTerm)
        || !isNonNegativeInteger(message.leaderCommit)
        || !Array.isArray(message.entries)
        || !message.entries.every(isValidEntry)
      ) {
        throw error('ERR_BAD_MESSAGE', 'append 消息形状不合法');
      }
      return;
    }

    if (message.type === 'appendResponse') {
      if (typeof message.success !== 'boolean') {
        throw error('ERR_BAD_MESSAGE', 'appendResponse.success 必须是布尔值');
      }
      if (message.success) {
        if (!isNonNegativeInteger(message.matchIndex)) {
          throw error('ERR_BAD_MESSAGE', '成功响应必须带 matchIndex');
        }
      } else if (!isNonNegativeInteger(message.conflictIndex)) {
        throw error('ERR_BAD_MESSAGE', '失败响应必须带 conflictIndex');
      }
      return;
    }

    if (message.type === 'snapshot') {
      if (
        !isNonNegativeInteger(message.lastIncludedIndex)
        || !isNonNegativeInteger(message.lastIncludedTerm)
      ) {
        throw error('ERR_BAD_MESSAGE', 'snapshot 消息形状不合法');
      }
      if (message.members !== undefined && !isValidMembers(message.members)) {
        throw error('ERR_BAD_MESSAGE', 'snapshot.members 形状不合法');
      }
      return;
    }

    if (message.type === 'snapshotResponse') {
      if (typeof message.success !== 'boolean' || !isNonNegativeInteger(message.matchIndex)) {
        throw error('ERR_BAD_MESSAGE', 'snapshotResponse 消息形状不合法');
      }
      return;
    }

    throw error('ERR_BAD_MESSAGE', '不认识的消息类型');
  }

  function step(message) {
    validateMessage(message);
    if (message.to !== id) {
      return [];
    }

    if (message.type === 'append') {
      return handleAppend(message);
    }
    if (message.type === 'appendResponse') {
      return handleAppendResponse(message);
    }
    if (message.type === 'snapshot') {
      return handleSnapshot(message);
    }
    return handleSnapshotResponse(message);
  }

  function snapshotNow() {
    if (commitIndex > snapshot.index) {
      const retainedOffset = commitIndex - snapshot.index;
      snapshot = { index: commitIndex, term: termAt(commitIndex) };
      log = log.slice(retainedOffset);
      if (isLeader) {
        for (const member of members) {
          if (member !== id && nextIndex.get(member) <= snapshot.index) {
            pendingSnapshots.add(member);
          }
        }
      }
    }
    return { ...snapshot };
  }

  function propose(command) {
    assertLeader();

    if (isConfigCommand(command)) {
      const nextMembers = command.config;
      if (!isValidMembers(nextMembers) || !nextMembers.includes(id)) {
        throw error('ERR_BAD_CONFIG', '配置成员表不合法');
      }
      const removed = members.filter((member) => !nextMembers.includes(member)).length;
      const added = nextMembers.filter((member) => !members.includes(member)).length;
      if (removed + added !== 1) {
        throw error('ERR_BAD_CONFIG', '一次只能变更一个成员');
      }
      applyConfig(nextMembers);
    }

    const index = lastIndex() + 1;
    log.push({ term: currentTerm, command });
    advanceCommitIndex();
    return { index, term: currentTerm };
  }

  function broadcast() {
    assertLeader();

    const messages = [];
    for (const member of members) {
      if (member === id) {
        continue;
      }

      const next = nextIndex.get(member);
      if (next <= snapshot.index || pendingSnapshots.has(member)) {
        messages.push({
          type: 'snapshot',
          from: id,
          to: member,
          term: currentTerm,
          lastIncludedIndex: snapshot.index,
          lastIncludedTerm: snapshot.term,
          members: [...members],
        });
        continue;
      }

      const prevIndex = next - 1;
      messages.push({
        type: 'append',
        from: id,
        to: member,
        term: currentTerm,
        prevIndex,
        prevTerm: termAt(prevIndex),
        entries: log.slice(prevIndex - snapshot.index).map(copyEntry),
        leaderCommit: commitIndex,
      });
    }
    return messages;
  }

  return {
    state() {
      return {
        id,
        term: currentTerm,
        leader: isLeader,
        leaderId,
        commitIndex,
        snapshot: { ...snapshot },
        members: [...members],
        entries: log.map((entry, offset) => ({
          index: snapshot.index + offset + 1,
          term: entry.term,
        })),
      };
    },
    lastIndex,
    lastTerm,
    termAt,
    commandAt,
    snapshotNow,
    propose,
    broadcast,
    step,
  };
}
