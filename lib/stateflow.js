// 层级状态机（SCXML 子集）的解释器。
//
// 口径见 README 的《口径》和《API》两节：状态树、初始链、历史状态、事件队列，
// 以及退/进的确定顺序。出错一律抛 lib/errors.js 里的 StateflowError。

import { StateflowError } from './errors.js';

export const DEFAULTS = {
  maxSteps: 100,
};

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const badMachine = (message, details = {}) =>
  new StateflowError('ERR_BAD_MACHINE', message, details);

const badEvent = (message, details = {}) =>
  new StateflowError('ERR_BAD_EVENT', message, details);

const TRANSITION_KEYS = ['target', 'when', 'assign', 'viaHistory'];

// 转换写成目标 id 的字符串，或者 { target, when?, assign?, viaHistory? }。
const parseTransition = (raw) => {
  if (typeof raw === 'string') {
    if (raw.length === 0) {
      throw badMachine('转换目标得是非空字符串');
    }
    return { target: raw, when: null, assign: null, viaHistory: false };
  }
  if (!isPlainObject(raw)) {
    throw badMachine('转换既不是字符串也不是对象');
  }
  for (const key of Object.keys(raw)) {
    if (!TRANSITION_KEYS.includes(key)) {
      throw badMachine(`转换对象里有不认识的字段: ${key}`, { key });
    }
  }
  const { target, when, assign, viaHistory } = raw;
  if (typeof target !== 'string' || target.length === 0) {
    throw badMachine('target 得是非空字符串', { target });
  }
  if (when !== undefined && !isPlainObject(when)) {
    throw badMachine('when 得是对象');
  }
  if (assign !== undefined && !isPlainObject(assign)) {
    throw badMachine('assign 得是对象');
  }
  return {
    target,
    when: when ?? null,
    assign: assign ?? null,
    viaHistory: viaHistory === true,
  };
};

// 把定义展开成状态树，返回根节点和全树的 id 索引。
const buildTree = (definition) => {
  if (!isPlainObject(definition)) {
    throw badMachine('机器定义得是一个对象');
  }
  const nodes = new Map();
  const build = (config, parent) => {
    if (!isPlainObject(config)) {
      throw badMachine('状态定义得是一个对象');
    }
    const { id, initial, states, history, final, on } = config;
    if (typeof id !== 'string' || id.length === 0) {
      throw badMachine('状态 id 得是非空字符串', { id });
    }
    if (nodes.has(id)) {
      throw badMachine(`状态 id 重复: ${id}`, { id });
    }
    const node = {
      id,
      parent,
      children: [],
      initialChild: null,
      history: history === true,
      final: final === true,
      on: new Map(),
    };
    nodes.set(id, node);
    if (states !== undefined) {
      if (!Array.isArray(states) || states.length === 0) {
        throw badMachine(`复合状态 ${id} 的 states 得是非空数组`, { id });
      }
      if (node.final) {
        throw badMachine(`final 状态 ${id} 不能带子状态`, { id });
      }
      if (initial === undefined) {
        throw badMachine(`复合状态 ${id} 缺 initial`, { id });
      }
      node.children = states.map((child) => build(child, node));
      node.initialChild = node.children.find((child) => child.id === initial) ?? null;
      if (node.initialChild === null) {
        throw badMachine(`复合状态 ${id} 的 initial 指不到直接子状态`, { id, initial });
      }
    } else {
      if (initial !== undefined) {
        throw badMachine(`叶子状态 ${id} 不能给 initial`, { id });
      }
      if (node.history) {
        throw badMachine(`叶子状态 ${id} 不能给 history`, { id });
      }
    }
    if (on !== undefined) {
      if (!isPlainObject(on)) {
        throw badMachine(`状态 ${id} 的 on 得是对象`, { id });
      }
      for (const [event, raw] of Object.entries(on)) {
        if (event.length === 0) {
          throw badMachine(`状态 ${id} 的 on 里有空事件名`, { id });
        }
        const list = Array.isArray(raw) ? raw : [raw];
        node.on.set(event, list.map(parseTransition));
      }
    }
    return node;
  };
  const root = build(definition, null);
  for (const node of nodes.values()) {
    for (const list of node.on.values()) {
      for (const transition of list) {
        if (!nodes.has(transition.target)) {
          throw badMachine(`转换目标在树里找不到: ${transition.target}`,
            { target: transition.target });
        }
      }
    }
  }
  return { root, nodes };
};

const checkEvent = (event) => {
  if (typeof event !== 'string' || event.length === 0) {
    throw badEvent('事件名得是非空字符串', { event });
  }
};

const matchesWhen = (when, context) =>
  when === null
  || Object.entries(when).every(([key, value]) => Object.is(context[key], value));

export function createMachine(definition, options = {}) {
  if (!isPlainObject(options)) {
    throw badMachine('options 得是对象');
  }
  const { context: initialContext = {} } = options;
  if (!isPlainObject(initialContext)) {
    throw badMachine('context 得是对象');
  }
  const { root, nodes } = buildTree(definition);
  const baseContext = { ...initialContext };

  let active = [];
  let context = {};
  let queue = [];
  let history = new Map();

  const initialChain = () => {
    const chain = [];
    let node = root;
    while (node !== null) {
      chain.push(node);
      node = node.initialChild;
    }
    return chain;
  };

  const snapshot = () => ({
    active: active.map((node) => node.id),
    context: { ...context },
    done: active.some((node) => node.final),
    queued: [...queue],
  });

  const lowestCommonAncestor = (one, two) => {
    const ancestors = new Set();
    for (let node = one; node !== null; node = node.parent) {
      ancestors.add(node);
    }
    for (let node = two; node !== null; node = node.parent) {
      if (ancestors.has(node)) {
        return node;
      }
    }
    return root;
  };

  // 从最深的活跃叶子往根找，先命中的状态先算；
  // 同一状态里同一个事件的多条转换按顺序挑第一个 when 满足的。
  const select = (event) => {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      const source = active[index];
      if (source.final) {
        continue;
      }
      const list = source.on.get(event);
      if (!list) {
        continue;
      }
      const transition = list.find((one) => matchesWhen(one.when, context));
      if (transition) {
        return { source, transition };
      }
    }
    return null;
  };

  const enter = (node, trace) => {
    trace.push({ type: 'enter', state: node.id });
    active.push(node);
  };

  const apply = ({ source, transition }, trace) => {
    const target = nodes.get(transition.target);
    const ancestor = lowestCommonAncestor(source, target);
    const keep = ancestor.parent ?? ancestor;

    // 退出：活跃集合里不等于 keep 的，从内到外；退出带 history 的复合状态时
    // 记下当时的那片叶子。
    const keepIndex = active.indexOf(keep);
    const leaf = active[active.length - 1];
    for (let index = active.length - 1; index > keepIndex; index -= 1) {
      const node = active[index];
      if (node.history) {
        history.set(node.id, leaf.id);
      }
      trace.push({ type: 'exit', state: node.id });
    }
    active = active.slice(0, keepIndex + 1);

    // assign 在退出之后、进入之前浅合并。
    if (transition.assign !== null) {
      context = { ...context, ...transition.assign };
    }

    // 进入：target 往上到 keep 的路径（不含 keep），从外到内。
    const path = [];
    for (let node = target; node !== keep; node = node.parent) {
      path.unshift(node);
    }
    for (const node of path) {
      enter(node, trace);
    }

    // 落到叶子：viaHistory 且记过就照历史走，否则顺着 initial 走到底。
    if (transition.viaHistory && history.has(target.id)) {
      const remembered = nodes.get(history.get(target.id));
      const down = [];
      for (let node = remembered; node !== target; node = node.parent) {
        down.unshift(node);
      }
      for (const node of down) {
        enter(node, trace);
      }
    } else {
      let node = target;
      while (node.initialChild !== null) {
        node = node.initialChild;
        enter(node, trace);
      }
    }
  };

  const send = (event) => {
    checkEvent(event);
    const trace = [];
    const handled = [];
    let matched = false;
    let steps = 0;

    const process = (name, isExternal) => {
      steps += 1;
      if (steps > DEFAULTS.maxSteps) {
        throw new StateflowError('ERR_TOO_MANY_EVENTS',
          `一轮处理的事件超过 ${DEFAULTS.maxSteps} 个`, { steps });
      }
      handled.push(name);
      const hit = select(name);
      if (hit === null) {
        return;
      }
      apply(hit, trace);
      if (isExternal) {
        matched = true;
      }
    };

    // 先按 FIFO 清完队列里的内部事件，再处理这次的外部事件；
    // 处理过程中新排进来的接在后面继续清。
    const backlog = queue;
    queue = [];
    for (const name of backlog) {
      process(name, false);
    }
    process(event, true);
    while (queue.length > 0) {
      process(queue.shift(), false);
    }

    return { matched, handled, trace, ...snapshot() };
  };

  const raise = (event) => {
    checkEvent(event);
    queue.push(event);
  };

  const reset = () => {
    active = initialChain();
    context = { ...baseContext };
    queue = [];
    history = new Map();
    return snapshot();
  };

  reset();

  return {
    state: snapshot,
    send,
    raise,
    reset,
  };
}

export function run(definition, events, options = {}) {
  if (!Array.isArray(events)) {
    throw badEvent('run 的 events 得是数组');
  }
  const machine = createMachine(definition, options);
  const results = events.map((event) => machine.send(event));
  const handled = results.flatMap((result) => result.handled);
  return { results, handled, ...machine.state() };
}
