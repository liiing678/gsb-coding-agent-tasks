import { RouteError } from './errors.js';

const DAY = 86400;

const badArgument = (message) => new RouteError('ERR_BAD_ARGUMENT', message, {});
const unknownNode = (node) =>
  new RouteError('ERR_UNKNOWN_NODE', `未知节点：${String(node)}`, { node });
const unknownEdgeNode = (edge) =>
  new RouteError('ERR_UNKNOWN_NODE', `边 ${String(edge)} 引用了未声明的节点`, { edge });

const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const isPositiveFinite = (value) => typeof value === 'number'
  && Number.isFinite(value) && value > 0;

const isDaySecond = (value) => typeof value === 'number'
  && Number.isFinite(value) && value >= 0 && value <= DAY;

// 口径同 test/util.js 的参考实现：
// 区间左闭右开；start > end 跨零点；start === end 整天封（永远进不去）；
// 命中封路就在起点干等到该段结束，跳完再扫一遍，几段首尾相接就一路跳完。
const entryTime = (windows, readyAt) => {
  let current = readyAt;
  for (let guard = 0; guard <= windows.length; guard += 1) {
    const second = ((current % DAY) + DAY) % DAY;
    let jumped = false;
    for (const window of windows) {
      const [start, end] = window;
      if (start === end) return null;
      let wait = null;
      if (start < end) {
        if (second >= start && second < end) wait = end - second;
      } else if (second >= start) {
        wait = DAY - second + end;
      } else if (second < end) {
        wait = end - second;
      }
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

// 边 id 序列字典序：逐段比字符串，前缀更短的更小。
const comparePath = (left, right) => {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
};

class MinHeap {
  constructor() {
    this.items = [];
  }

  static less(left, right) {
    if (left[0] !== right[0]) return left[0] < right[0];
    return comparePath(left[2], right[2]) < 0;
  }

  push(item) {
    const items = this.items;
    let index = items.length;
    items.push(item);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!MinHeap.less(items[index], items[parent])) break;
      [items[index], items[parent]] = [items[parent], items[index]];
      index = parent;
    }
  }

  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let next = index;
        if (left < items.length && MinHeap.less(items[left], items[next])) next = left;
        if (right < items.length && MinHeap.less(items[right], items[next])) next = right;
        if (next === index) break;
        [items[index], items[next]] = [items[next], items[index]];
        index = next;
      }
    }
    return top;
  }

  get size() {
    return this.items.length;
  }
}

export function createRouter(data) {
  if (!isPlainObject(data)) {
    throw badArgument('createRouter 的参数得是普通对象');
  }
  const { nodes, edges } = data;
  let { turns } = data;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    throw badArgument('nodes 和 edges 都得是数组');
  }
  if (turns === undefined) {
    turns = [];
  } else if (!Array.isArray(turns)) {
    throw badArgument('turns 得是数组');
  }

  const nodeSet = new Set();
  for (const node of nodes) {
    if (!isNonEmptyString(node)) throw badArgument('节点名得是非空字符串');
    if (nodeSet.has(node)) throw badArgument(`节点重复：${node}`);
    nodeSet.add(node);
  }

  const edgeList = [];
  const edgeIds = new Map();
  for (const edge of edges) {
    if (!isPlainObject(edge)) throw badArgument('每条边都得是对象');
    const { id, from, to, length, speed } = edge;
    if (!isNonEmptyString(id)) throw badArgument('边 id 得是非空字符串');
    if (edgeIds.has(id)) throw badArgument(`边 id 重复：${id}`);
    if (!isPositiveFinite(length) || !isPositiveFinite(speed)) {
      throw badArgument(`边 ${id} 的 length / speed 得是正有限数`);
    }
    let closures = edge.closures;
    if (closures === undefined) {
      closures = [];
    } else {
      if (!Array.isArray(closures)) throw badArgument(`边 ${id} 的 closures 得是数组`);
      const copied = [];
      for (const window of closures) {
        if (!Array.isArray(window) || window.length !== 2
          || !isDaySecond(window[0]) || !isDaySecond(window[1])) {
          throw badArgument(`边 ${id} 的封路区间都得是 [0,86400] 内的两个有限数`);
        }
        copied.push([window[0], window[1]]);
      }
      closures = copied;
    }
    if (!nodeSet.has(from)) throw unknownEdgeNode(id);
    if (!nodeSet.has(to)) throw unknownEdgeNode(id);
    edgeIds.set(id, edgeList.length);
    edgeList.push({
      id,
      from,
      to,
      length,
      speed,
      seconds: length / speed,
      closures,
    });
  }

  // restrictions: from 边 id -> via 节点 -> { no: Set<to 边 id>, only: Set<to 边 id> }
  const restrictions = new Map();
  for (const turn of turns) {
    if (!isPlainObject(turn) || (turn.kind !== 'no' && turn.kind !== 'only')) {
      throw badArgument("转弯限制得是对象，且 kind 只能是 'no' / 'only'");
    }
    const { from, via, to, kind } = turn;
    if (!edgeIds.has(from)) throw unknownNode(from);
    if (!nodeSet.has(via)) throw unknownNode(via);
    if (!edgeIds.has(to)) throw unknownNode(to);
    let viaMap = restrictions.get(from);
    if (viaMap === undefined) {
      viaMap = new Map();
      restrictions.set(from, viaMap);
    }
    let rule = viaMap.get(via);
    if (rule === undefined) {
      rule = { no: new Set(), only: new Set() };
      viaMap.set(via, rule);
    }
    rule[kind].add(to);
  }

  const outgoing = new Map();
  for (const node of nodeSet) outgoing.set(node, []);
  edgeList.forEach((edge, index) => outgoing.get(edge.from).push(index));

  // 状态 = 刚走完的边（其终点即当前节点）。预算好每个状态允许接的下一条边；
  // via 跟上一条边终点对不上的限制自然查不到，等于挂着好看。
  const allowedNext = edgeList.map((edge) => {
    const rule = restrictions.get(edge.id)?.get(edge.to);
    const candidates = outgoing.get(edge.to);
    if (rule === undefined) return candidates;
    return candidates.filter((next) => {
      const nextId = edgeList[next].id;
      if (rule.no.has(nextId)) return false;
      if (rule.only.size > 0 && !rule.only.has(nextId)) return false;
      return true;
    });
  });

  const route = (options) => {
    if (options === undefined) options = {};
    if (!isPlainObject(options)) throw badArgument('route 的参数得是普通对象');
    let { departAt } = options;
    if (departAt === undefined) {
      departAt = 0;
    } else if (typeof departAt !== 'number'
      || !Number.isFinite(departAt) || departAt < 0) {
      throw badArgument('departAt 得是 >= 0 的有限数');
    }
    const { from, to } = options;
    if (!nodeSet.has(from)) throw unknownNode(from);
    if (!nodeSet.has(to)) throw unknownNode(to);
    if (from === to) return { arrive: departAt, seconds: 0, path: [] };

    const count = edgeList.length;
    const bestTime = new Float64Array(count).fill(Infinity);
    const bestPath = new Array(count).fill(null);
    const settled = new Uint8Array(count);
    // 堆项：[到达时刻, 边状态下标(-1 表示起点), path]
    const heap = new MinHeap();
    heap.push([departAt, -1, []]);

    while (heap.size > 0) {
      const [time, state, path] = heap.pop();
      if (state !== -1) {
        if (settled[state] || bestPath[state] !== path) continue;
        settled[state] = 1;
      }
      const node = state === -1 ? from : edgeList[state].to;
      if (node === to) {
        return { arrive: time, seconds: time - departAt, path: [...path] };
      }
      // 起点迈出去的第一条边前面没有边，任何 no / only 都管不着。
      const candidates = state === -1 ? outgoing.get(from) : allowedNext[state];
      for (const next of candidates) {
        const edge = edgeList[next];
        const entry = entryTime(edge.closures, time);
        if (entry === null) continue; // 整天封着，这条边用不了
        const arriveAt = entry + edge.seconds;
        const nextPath = [...path, edge.id];
        const better = bestTime[next] === Infinity
          || arriveAt < bestTime[next]
          || (arriveAt === bestTime[next]
            && comparePath(nextPath, bestPath[next]) < 0);
        if (!better) continue;
        bestTime[next] = arriveAt;
        bestPath[next] = nextPath;
        heap.push([arriveAt, next, nextPath]);
      }
    }
    return null;
  };

  const edgesSnapshot = () => edgeList.map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    length: edge.length,
    speed: edge.speed,
    seconds: edge.seconds,
    closures: edge.closures.map((window) => [window[0], window[1]]),
  }));

  const stats = () => ({
    nodes: nodeSet.size,
    edges: edgeList.length,
    turns: turns.length,
  });

  return { route, edges: edgesSnapshot, stats };
}
