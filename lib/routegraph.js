// 含转弯限制与封路时间窗的最早到达路由。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/route.test.js、test/edge.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》 两节
// 写好了。那些约定不要改，把这里补出来。

import { RouteError } from './errors.js';

export function createRouter(data) {
  const DAY = 86400;

  const badArgument = (message = 'invalid route graph argument') => {
    throw new RouteError('ERR_BAD_ARGUMENT', message, {});
  };

  const unknownNode = (node) => {
    throw new RouteError('ERR_UNKNOWN_NODE', `unknown node: ${String(node)}`, { node });
  };

  const isPlainObject = (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };

  const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

  if (!isPlainObject(data)) badArgument('router data must be an object');
  if (!Array.isArray(data.nodes)) badArgument('nodes must be an array');
  if (!Array.isArray(data.edges)) badArgument('edges must be an array');
  const turns = data.turns === undefined ? [] : data.turns;
  if (!Array.isArray(turns)) badArgument('turns must be an array');

  const nodeSet = new Set();
  for (const node of data.nodes) {
    if (!isNonEmptyString(node) || nodeSet.has(node)) badArgument('duplicate or invalid node');
    nodeSet.add(node);
  }

  const graphEdges = [];
  const edgeById = new Map();

  for (const edge of data.edges) {
    if (!isPlainObject(edge) || !isNonEmptyString(edge.id) || edgeById.has(edge.id)) {
      badArgument('duplicate or invalid edge id');
    }
    if (!Number.isFinite(edge.length) || edge.length <= 0
      || !Number.isFinite(edge.speed) || edge.speed <= 0) {
      badArgument('edge length and speed must be positive finite numbers');
    }

    const sourceClosures = edge.closures === undefined ? [] : edge.closures;
    if (!Array.isArray(sourceClosures)) badArgument('closures must be an array');
    const closures = [];
    let sealed = false;
    for (const window of sourceClosures) {
      if (!Array.isArray(window) || window.length !== 2
        || !Number.isFinite(window[0]) || !Number.isFinite(window[1])
        || window[0] < 0 || window[0] > DAY || window[1] < 0 || window[1] > DAY) {
        badArgument('closure windows must contain two finite seconds between 0 and 86400');
      }
      const start = window[0];
      const end = window[1];
      closures.push([start, end]);
      if (start === end || (start === 0 && end === DAY)) sealed = true;
    }

    if (!nodeSet.has(edge.from)) {
      throw new RouteError('ERR_UNKNOWN_NODE', `unknown node: ${String(edge.from)}`, { edge: edge.id });
    }
    if (!nodeSet.has(edge.to)) {
      throw new RouteError('ERR_UNKNOWN_NODE', `unknown node: ${String(edge.to)}`, { edge: edge.id });
    }

    const builtEdge = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      length: edge.length,
      speed: edge.speed,
      seconds: edge.length / edge.speed,
      closures,
      sealed,
    };
    graphEdges.push(builtEdge);
    edgeById.set(builtEdge.id, builtEdge);
  }

  const outgoing = new Map();
  for (const node of nodeSet) outgoing.set(node, []);
  for (const edge of graphEdges) {
    if (!edge.sealed) outgoing.get(edge.from).push(edge);
  }

  const bannedTurns = new Map();
  const onlyTurns = new Map();

  const indexTurn = (index, from, via, to) => {
    let byVia = index.get(from);
    if (byVia === undefined) {
      byVia = new Map();
      index.set(from, byVia);
    }
    let targets = byVia.get(via);
    if (targets === undefined) {
      targets = new Set();
      byVia.set(via, targets);
    }
    targets.add(to);
  };

  for (const turn of turns) {
    if (!isPlainObject(turn) || (turn.kind !== 'no' && turn.kind !== 'only')) {
      badArgument('turn kind must be "no" or "only"');
    }
    if (!edgeById.has(turn.from)) {
      throw new RouteError('ERR_UNKNOWN_NODE', 'unknown edge in turn', { edge: turn.from });
    }
    if (!edgeById.has(turn.to)) {
      throw new RouteError('ERR_UNKNOWN_NODE', 'unknown edge in turn', { edge: turn.to });
    }
    if (!nodeSet.has(turn.via)) unknownNode(turn.via);

    const incoming = edgeById.get(turn.from);
    if (incoming.to !== turn.via) continue;

    if (turn.kind === 'no') {
      indexTurn(bannedTurns, turn.from, turn.via, turn.to);
    } else {
      indexTurn(onlyTurns, turn.from, turn.via, turn.to);
    }
  }

  const comparePaths = (left, right) => {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      if (left[index] < right[index]) return -1;
      if (left[index] > right[index]) return 1;
    }
    return left.length - right.length;
  };

  const isBetter = (left, right) => {
    if (left.time !== right.time) return left.time < right.time;
    return comparePaths(left.path, right.path) < 0;
  };

  class MinHeap {
    constructor() {
      this.items = [];
    }

    add(item) {
      const items = this.items;
      items.push(item);
      let index = items.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (!isBetter(items[index], items[parent])) break;
        [items[index], items[parent]] = [items[parent], items[index]];
        index = parent;
      }
    }

    pop() {
      const items = this.items;
      const first = items[0];
      const last = items.pop();
      if (items.length > 0) {
        items[0] = last;
        let index = 0;
        const size = items.length;
        while (true) {
          const left = index * 2 + 1;
          const right = left + 1;
          let smallest = index;
          if (left < size && isBetter(items[left], items[smallest])) smallest = left;
          if (right < size && isBetter(items[right], items[smallest])) smallest = right;
          if (smallest === index) break;
          [items[index], items[smallest]] = [items[smallest], items[index]];
          index = smallest;
        }
      }
      return first;
    }

    get size() {
      return this.items.length;
    }
  }

  const turnAllows = (incomingId, via, nextId) => {
    if (bannedTurns.get(incomingId)?.get(via)?.has(nextId) === true) return false;
    const allowed = onlyTurns.get(incomingId)?.get(via);
    if (allowed !== undefined && !allowed.has(nextId)) return false;
    return true;
  };

  const earliestEntry = (edge, readyAt) => {
    if (edge.sealed) return null;
    let time = readyAt;
    for (let jumps = 0; jumps <= edge.closures.length; jumps += 1) {
      const secondOfDay = time % DAY;
      let waiting = null;
      for (const [start, end] of edge.closures) {
        if (start < end) {
          if (secondOfDay >= start && secondOfDay < end) waiting = end - secondOfDay;
        } else if (secondOfDay >= start) {
          waiting = DAY - secondOfDay + end;
        } else if (secondOfDay < end) {
          waiting = end - secondOfDay;
        }
        if (waiting !== null) break;
      }
      if (waiting === null) return time;
      time += waiting;
    }
    return null;
  };

  const findRoute = (from, to, departAt) => {
    if (from === to) return { arrive: departAt, seconds: 0, path: [] };

    const best = new Map();
    const settled = new Set();
    const heap = new MinHeap();

    for (const edge of outgoing.get(from)) {
      const entryAt = earliestEntry(edge, departAt);
      if (entryAt === null) continue;
      const state = {
        edgeId: edge.id,
        time: entryAt + edge.seconds,
        path: [edge.id],
      };
      best.set(edge.id, state);
      heap.add(state);
    }

    while (heap.size > 0) {
      const current = heap.pop();
      if (settled.has(current.edgeId)) continue;
      settled.add(current.edgeId);

      const currentEdge = edgeById.get(current.edgeId);
      if (currentEdge.to === to) {
        return {
          arrive: current.time,
          seconds: current.time - departAt,
          path: current.path,
        };
      }

      for (const nextEdge of outgoing.get(currentEdge.to)) {
        if (!turnAllows(currentEdge.id, currentEdge.to, nextEdge.id)) continue;
        const entryAt = earliestEntry(nextEdge, current.time);
        if (entryAt === null) continue;

        const candidate = {
          edgeId: nextEdge.id,
          time: entryAt + nextEdge.seconds,
          path: current.path.concat(nextEdge.id),
        };
        const previous = best.get(nextEdge.id);
        if (previous === undefined || isBetter(candidate, previous)) {
          best.set(nextEdge.id, candidate);
          heap.add(candidate);
        }
      }
    }

    return null;
  };

  return {
    route(options = {}) {
      if (!isPlainObject(options)) badArgument('route options must be an object');
      const departAt = options.departAt === undefined ? 0 : options.departAt;
      if (!Number.isFinite(departAt) || departAt < 0) {
        badArgument('departAt must be a finite number >= 0');
      }
      if (!nodeSet.has(options.from)) unknownNode(options.from);
      if (!nodeSet.has(options.to)) unknownNode(options.to);
      return findRoute(options.from, options.to, departAt);
    },

    edges() {
      return graphEdges.map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        length: edge.length,
        speed: edge.speed,
        seconds: edge.seconds,
        closures: edge.closures.map((window) => [window[0], window[1]]),
      }));
    },

    stats() {
      return {
        nodes: nodeSet.size,
        edges: graphEdges.length,
        turns: turns.length,
      };
    },
  };
}
