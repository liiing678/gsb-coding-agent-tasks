import { RaftlogError } from './errors.js';

const str = (v) => typeof v === 'string' && v.length > 0;
const int = (v) => Number.isInteger(v) && v >= 0;
const err = (code, msg) => new RaftlogError(code, msg);

function validMembers(v) {
  return Array.isArray(v) && v.length > 0 && v.every(str) && new Set(v).size === v.length;
}
function isConfig(command) {
  return command && typeof command === 'object' && !Array.isArray(command)
    && Object.hasOwn(command, 'config');
}
function validEntry(e) {
  return e && typeof e === 'object' && !Array.isArray(e) && int(e.term)
    && Object.hasOwn(e, 'command');
}

export function createNode(cfg = {}) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg))
    throw err('ERR_BAD_CONFIG', '节点配置必须是对象');
  const { id } = cfg;
  if (!str(id)) throw err('ERR_BAD_CONFIG', 'id 必须是非空字符串');
  if (!validMembers(cfg.members) || !cfg.members.includes(id))
    throw err('ERR_BAD_CONFIG', 'members 必须包含当前节点且非空不重复');
  if (!int(cfg.term ?? 0)) throw err('ERR_BAD_CONFIG', 'term 必须是非负整数');
  if (cfg.leader !== undefined && typeof cfg.leader !== 'boolean')
    throw err('ERR_BAD_CONFIG', 'leader 必须是布尔值');
  const snapInput = cfg.snapshot ?? { index: 0, term: 0 };
  if (!snapInput || typeof snapInput !== 'object' || Array.isArray(snapInput)
    || !int(snapInput.index) || !int(snapInput.term))
    throw err('ERR_BAD_CONFIG', 'snapshot 必须包含非负整数 index 和 term');
  if (!Array.isArray(cfg.entries ?? [])) throw err('ERR_BAD_CONFIG', 'entries 必须是数组');
  if ((cfg.entries ?? []).some((e) => !validEntry(e)))
    throw err('ERR_BAD_CONFIG', '日志条目形状不合法');

  let currentTerm = cfg.term ?? 0;
  let isLeader = cfg.leader === true;
  let leaderId = null;
  let members = [...cfg.members];
  let snapshot = { index: snapInput.index, term: snapInput.term };
  let log = (cfg.entries ?? []).map((e) => ({ term: e.term, command: e.command }));
  let commitIndex = snapshot.index;
  const match = new Map();
  const next = new Map();
  const pending = new Set();

  const lastIndex = () => snapshot.index + log.length;
  const lastTerm = () => log.length ? log.at(-1).term : snapshot.term;

  function resetProgress() {
    match.clear();
    next.clear();
    pending.clear();
  }
  function initProgress() {
    resetProgress();
    for (const member of members) {
      if (member !== id) {
        match.set(member, 0);
        next.set(member, lastIndex() + 1);
      }
    }
  }
  if (isLeader) initProgress();

  function termAt(index) {
    if (index === snapshot.index) return snapshot.term;
    if (index <= snapshot.index || index > lastIndex())
      throw err('ERR_LOG_MISSING', `日志下标 ${index} 不存在`);
    return log[index - snapshot.index - 1].term;
  }
  function commandAt(index) {
    if (index <= snapshot.index || index > lastIndex())
      throw err('ERR_LOG_MISSING', `日志下标 ${index} 不存在`);
    return log[index - snapshot.index - 1].command;
  }

  function applyConfigs(fromIndex, toIndex) {
    for (let index = fromIndex; index <= toIndex; index += 1) {
      const command = log[index - snapshot.index - 1].command;
      if (isConfig(command)) members = [...command.config];
    }
  }
  function advanceCommit(toIndex) {
    if (toIndex <= commitIndex || toIndex > lastIndex()) return;
    const fromIndex = commitIndex + 1;
    commitIndex = toIndex;
    applyConfigs(fromIndex, toIndex);
  }

  function validateConfig(nextMembers) {
    if (!validMembers(nextMembers) || !nextMembers.includes(id))
      throw err('ERR_BAD_CONFIG', '配置条目不合法');
    const removed = members.filter((m) => !nextMembers.includes(m)).length;
    const added = nextMembers.filter((m) => !members.includes(m)).length;
    if (removed + added !== 1)
      throw err('ERR_BAD_CONFIG', '一次只能变更一个成员');
  }
  function applyLeaderConfig(nextMembers) {
    const oldMembers = new Set(members);
    for (const member of members) {
      if (!nextMembers.includes(member)) {
        match.delete(member);
        next.delete(member);
        pending.delete(member);
      }
    }
    members = [...nextMembers];
    for (const member of members) {
      if (member !== id && !oldMembers.has(member)) {
        match.set(member, 0);
        next.set(member, lastIndex() + 1);
      }
    }
  }

  function recomputeCommit() {
    const values = [lastIndex()];
    for (const member of members) {
      if (member !== id) values.push(match.get(member) ?? 0);
    }
    values.sort((a, b) => b - a);
    const candidate = values[Math.floor(members.length / 2)];
    if (candidate > commitIndex && termAt(candidate) === currentTerm) {
      advanceCommit(candidate);
    }
  }

  function snapshotNow() {
    if (commitIndex > snapshot.index) {
      const nextSnapshot = { index: commitIndex, term: termAt(commitIndex) };
      log = log.slice(commitIndex - snapshot.index);
      snapshot = nextSnapshot;
    }
    return { ...snapshot };
  }

  function validateMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message))
      throw err('ERR_BAD_MESSAGE', '消息必须是对象');
    if (!['append', 'appendResponse', 'snapshot', 'snapshotResponse'].includes(message.type))
      throw err('ERR_BAD_MESSAGE', '不认识的消息类型');
    if (!str(message.from) || !str(message.to))
      throw err('ERR_BAD_MESSAGE', 'from/to 必须是非空字符串');
    if (!int(message.term)) throw err('ERR_BAD_MESSAGE', 'term 必须是非负整数');

    if (message.type === 'append') {
      if (!int(message.prevIndex) || !int(message.prevTerm) || !int(message.leaderCommit)
        || !Array.isArray(message.entries)
        || message.entries.some((e) => !validEntry(e)))
        throw err('ERR_BAD_MESSAGE', 'append 消息字段不合法');
    } else if (message.type === 'appendResponse') {
      if (typeof message.success !== 'boolean')
        throw err('ERR_BAD_MESSAGE', 'success 必须是布尔值');
      const field = message.success ? 'matchIndex' : 'conflictIndex';
      if (!int(message[field]))
        throw err('ERR_BAD_MESSAGE', `${field} 必须是非负整数`);
    } else if (message.type === 'snapshot') {
      if (!int(message.lastIncludedIndex) || !int(message.lastIncludedTerm)
        || (message.members !== undefined && !validMembers(message.members)))
        throw err('ERR_BAD_MESSAGE', 'snapshot 消息字段不合法');
    } else if (typeof message.success !== 'boolean' || !int(message.matchIndex)) {
      throw err('ERR_BAD_MESSAGE', 'snapshotResponse 字段不合法');
    }
  }

  function stepDown(message) {
    const wasLeader = isLeader;
    currentTerm = message.term;
    isLeader = false;
    leaderId = null;
    if (wasLeader) resetProgress();
  }

  function appendResponse(to, success, field, value) {
    return {
      type: 'appendResponse', from: id, to, term: currentTerm, success, [field]: value,
    };
  }
  function snapshotResponse(to, success, matchIndex) {
    return {
      type: 'snapshotResponse', from: id, to, term: currentTerm, success, matchIndex,
    };
  }

  function handleAppend(message) {
    if (message.term < currentTerm)
      return [appendResponse(message.from, false, 'conflictIndex', lastIndex() + 1)];
    if (message.term > currentTerm) stepDown(message);
    leaderId = message.from;

    if (message.prevIndex < snapshot.index)
      return [appendResponse(message.from, false, 'conflictIndex', snapshot.index + 1)];
    if (message.prevIndex > lastIndex())
      return [appendResponse(message.from, false, 'conflictIndex', lastIndex() + 1)];
    if (message.prevIndex === snapshot.index) {
      if (message.prevTerm !== snapshot.term)
        return [appendResponse(message.from, false, 'conflictIndex', 0)];
    } else if (termAt(message.prevIndex) !== message.prevTerm) {
      const conflictingTerm = termAt(message.prevIndex);
      const position = log.findIndex((e) => e.term === conflictingTerm);
      return [appendResponse(
        message.from, false, 'conflictIndex', snapshot.index + position + 1,
      )];
    }

    for (let offset = 0; offset < message.entries.length; offset += 1) {
      const position = message.prevIndex - snapshot.index + offset;
      const incoming = message.entries[offset];
      if (position < log.length) {
        if (log[position].term !== incoming.term) {
          log.length = position;
          for (const entry of message.entries.slice(offset))
            log.push({ term: entry.term, command: entry.command });
          break;
        }
      } else {
        for (const entry of message.entries.slice(offset))
          log.push({ term: entry.term, command: entry.command });
        break;
      }
    }

    const previousCommit = commitIndex;
    commitIndex = Math.max(commitIndex, Math.min(message.leaderCommit, lastIndex()));
    if (commitIndex > previousCommit) applyConfigs(previousCommit + 1, commitIndex);

    return [appendResponse(
      message.from, true, 'matchIndex',
      message.prevIndex + message.entries.length,
    )];
  }

  function handleAppendResponse(message) {
    if (message.term > currentTerm) stepDown(message);
    if (!isLeader || message.term !== currentTerm || !members.includes(message.from))
      return [];

    const follower = message.from;
    if (message.success) {
      match.set(follower, Math.max(match.get(follower) ?? 0, message.matchIndex));
      next.set(follower, Math.max(next.get(follower) ?? lastIndex() + 1,
        message.matchIndex + 1));
      pending.delete(follower);
    } else {
      const retryIndex = Math.max(1, message.conflictIndex);
      next.set(follower, retryIndex);
      if (retryIndex <= snapshot.index) pending.add(follower);
    }
    recomputeCommit();
    return [];
  }

  function handleSnapshot(message) {
    if (message.term < currentTerm)
      return [snapshotResponse(message.from, false, 0)];
    if (message.term > currentTerm) stepDown(message);
    leaderId = message.from;

    if (message.lastIncludedIndex <= commitIndex)
      return [snapshotResponse(message.from, true, message.lastIncludedIndex)];

    if (message.lastIncludedIndex <= lastIndex()
      && termAt(message.lastIncludedIndex) === message.lastIncludedTerm) {
      log = log.slice(message.lastIncludedIndex - snapshot.index);
    } else {
      log = [];
    }

    snapshot = {
      index: message.lastIncludedIndex,
      term: message.lastIncludedTerm,
    };
    commitIndex = Math.max(commitIndex, message.lastIncludedIndex);
    if (message.members !== undefined) members = [...message.members];

    return [snapshotResponse(message.from, true, message.lastIncludedIndex)];
  }

  function handleSnapshotResponse(message) {
    if (message.term > currentTerm) stepDown(message);
    if (!isLeader || message.term !== currentTerm || !message.success
      || !members.includes(message.from)) return [];

    const follower = message.from;
    match.set(follower, Math.max(match.get(follower) ?? 0, message.matchIndex));
    next.set(follower, Math.max(next.get(follower) ?? lastIndex() + 1,
      message.matchIndex + 1));
    pending.delete(follower);
    recomputeCommit();
    return [];
  }

  function requireLeader() {
    if (!isLeader) throw err('ERR_NOT_LEADER', '当前节点不是 leader');
  }

  function propose(command) {
    requireLeader();
    if (isConfig(command)) validateConfig(command.config);

    const index = lastIndex() + 1;
    log.push({ term: currentTerm, command });
    if (isConfig(command)) applyLeaderConfig(command.config);
    recomputeCommit();
    return { index, term: currentTerm };
  }

  function broadcast() {
    requireLeader();
    const messages = [];

    for (const member of members) {
      if (member === id) continue;

      if ((next.get(member) ?? lastIndex() + 1) <= snapshot.index
        || pending.has(member)) {
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

      const followerNext = next.get(member);
      messages.push({
        type: 'append',
        from: id,
        to: member,
        term: currentTerm,
        prevIndex: followerNext - 1,
        prevTerm: termAt(followerNext - 1),
        entries: log.slice(followerNext - snapshot.index - 1).map((entry) => ({
          term: entry.term,
          command: entry.command,
        })),
        leaderCommit: commitIndex,
      });
    }

    return messages;
  }

  function step(message) {
    validateMessage(message);
    if (message.to !== id) return [];

    switch (message.type) {
      case 'append': return handleAppend(message);
      case 'appendResponse': return handleAppendResponse(message);
      case 'snapshot': return handleSnapshot(message);
      case 'snapshotResponse': return handleSnapshotResponse(message);
      default: return [];
    }
  }

  function state() {
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
  }

  return {
    state,
    step,
    lastIndex,
    lastTerm,
    termAt,
    commandAt,
    snapshotNow,
    broadcast,
    propose,
  };
}
