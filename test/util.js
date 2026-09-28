import { RouteError } from '../lib/errors.js';

const DAY = 86400;

export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof RouteError ? err.code : `NOT_ROUTE:${err.message}`;
  }
};

export const close = (left, right) => Math.abs(left - right) < 1e-9;

// 按 README 的规矩自己走一遍：这条边最早什么时候能进
const entryTime = (edge, readyAt) => {
  const windows = edge.closures ?? [];
  let current = readyAt;
  for (let guard = 0; guard <= windows.length; guard += 1) {
    const second = ((current % DAY) + DAY) % DAY;
    let jumped = false;
    for (const [start, end] of windows) {
      if (start === end) return null;
      let wait = null;
      if (start < end) {
        if (second >= start && second < end) wait = end - second;
      } else if (second >= start) wait = DAY - second + end;
      else if (second < end) wait = end - second;
      if (wait !== null) {
        current += wait;
        jumped = true;
        break;
      }
    }
    if (!jumped) return current;
  }
  return null;
};

export const simulate = (data, from, path, departAt) => {
  const byId = new Map(data.edges.map((edge) => [edge.id, edge]));
  const turns = data.turns ?? [];
  let node = from;
  let time = departAt;
  let previous = null;
  for (const id of path) {
    const edge = byId.get(id);
    if (edge === undefined || edge.from !== node) return null;
    if (previous !== null) {
      const banned = turns.some((turn) => turn.kind === 'no'
        && turn.from === previous && turn.via === node && turn.to === id);
      if (banned) return null;
      const only = turns.filter((turn) => turn.kind === 'only'
        && turn.from === previous && turn.via === node);
      if (only.length > 0 && !only.some((turn) => turn.to === id)) return null;
    }
    const entry = entryTime(edge, time);
    if (entry === null) return null;
    time = entry + edge.length / edge.speed;
    previous = id;
    node = edge.to;
  }
  return { arrive: time, node };
};

export const simplePaths = (data, from, to, limit = 7) => {
  const outgoing = new Map(data.nodes.map((node) => [node, []]));
  for (const edge of data.edges) outgoing.get(edge.from).push(edge);
  const found = [];
  const walk = (node, visited, path) => {
    if (found.length > 5000 || path.length > limit) return;
    if (node === to && path.length > 0) {
      found.push([...path]);
      return;
    }
    for (const edge of outgoing.get(node)) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      path.push(edge.id);
      walk(edge.to, visited, path);
      path.pop();
      visited.delete(edge.to);
    }
  };
  walk(from, new Set([from]), []);
  return found;
};

export const mulberry32 = (seed) => () => {
  let state = (seed += 0x6d2b79f5);
  state = Math.imul(state ^ (state >>> 15), state | 1);
  state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
  return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
};
