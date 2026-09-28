// 层级状态机（SCXML 子集）的解释器：状态树、初始链、历史状态、内部事件队列。
// 退/进顺序、keep 的取法、assign 的时机、历史的记与用，全部照 README《口径》。

import { StateflowError } from './errors.js';

export const DEFAULTS = {
  maxSteps: 100,
};

const TRANSITION_KEYS = new Set(['target', 'when', 'assign', 'viaHistory']);

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value) =>
  typeof value === 'string' && value.length > 0;

const badMachine = (message) => {
  throw new StateflowError('ERR_BAD_MACHINE', message);
};

const badEvent = (message) => {
  throw new StateflowError('ERR_BAD_EVENT', message);
};

// 先做结构校验并建树，再统一检查转换 target 在全树里存不存在。
function buildTree(definition) {
  if (!isPlainObject(definition)) {
    badMachine('机器定义必须是对象');
  }

  const nodes = new Map();
  const pendingTargets = [];

  const validateTransition = (raw, ownerId, eventName) => {
    if (isNonEmptyString(raw)) {
      const transition = { target: raw, when: null, assign: null, viaHistory: false };
      pendingTargets.push({ transition, ownerId, eventName });
      return transition;
    }
    if (!isPlainObject(raw)) {
      badMachine(`状态 ${ownerId} 上事件 ${eventName} 的转换既不是字符串也不是对象`);
    }
    for (const key of Object.keys(raw)) {
      if (!TRANSITION_KEYS.has(key)) {
        badMachine(`状态 ${ownerId} 上事件 ${eventName} 的转换有不认识的字段 ${key}`);
      }
    }
    if (!isNonEmptyString(raw.target)) {
      badMachine(`状态 ${ownerId} 上事件 ${eventName} 的转换缺少 target`);
    }
    if (raw.when !== undefined && !isPlainObject(raw.when)) {
      badMachine(`状态 ${ownerId} 上事件 ${eventName} 的 when 必须是对象`);
    }
    if (raw.assign !== undefined && !isPlainObject(raw.assign)) {
      badMachine(`状态 ${ownerId} 上事件 ${eventName} 的 assign 必须是对象`);
    }
    const transition = {
      target: raw.target,
      when: raw.when ?? null,
      assign: raw.assign ?? null,
      viaHistory: raw.viaHistory === true,
    };
    pendingTargets.push({ transition, ownerId, eventName });
    return transition;
  };

  const build = (def, parent) => {
    if (!isPlainObject(def)) {
      badMachine('状态定义必须是对象');
    }
    if (!isNonEmptyString(def.id)) {
      badMachine('状态 id 必须是非空字符串');
    }
    if (nodes.has(def.id)) {
      badMachine(`状态 id 重复：${def.id}`);
    }

    const node = {
      id: def.id,
      def,
      parent,
      children: new Map(),
      transitions: new Map(),
      composite: def.states !== undefined,
      path: parent ? [...parent.path, def.id] : [def.id],
    };
    nodes.set(def.id, node);

    if (node.composite) {
      if (!Array.isArray(def.states) || def.states.length === 0) {
        badMachine(`复合状态 ${def.id} 的 states 必须是非空数组`);
      }
      for (const childDef of def.states) {
        const child = build(childDef, node);
        node.children.set(child.id, child);
      }
      if (!isNonEmptyString(def.initial) || !node.children.has(def.initial)) {
        badMachine(`复合状态 ${def.id} 的 initial 必须指向某个直接子状态`);
      }
    } else if (def.initial !== undefined) {
      badMachine(`叶子状态 ${def.id} 不能给 initial`);
    }

    if (def.final === true && node.composite) {
      badMachine(`final 状态 ${def.id} 不能带子状态`);
    }
    if (def.history === true && !node.composite) {
      badMachine(`history 只能给复合状态，${def.id} 是叶子`);
    }

    if (def.on !== undefined) {
      if (!isPlainObject(def.on)) {
        badMachine(`状态 ${def.id} 的 on 必须是对象`);
      }
      for (const [eventName, rawList] of Object.entries(def.on)) {
        if (!isNonEmptyString(eventName)) {
          badMachine(`状态 ${def.id} 上的事件名不能为空串`);
        }
        const list = Array.isArray(rawList) ? rawList : [rawList];
        node.transitions.set(
          eventName,
          list.map((raw) => validateTransition(raw, def.id, eventName)),
        );
      }
    }

    return node;
  };

  const root = build(definition, null);

  for (const { transition, ownerId, eventName } of pendingTargets) {
    if (!nodes.has(transition.target)) {
      badMachine(`状态 ${ownerId} 上事件 ${eventName} 的 target ${transition.target} 在树里找不到`);
    }
  }

  return { root, nodes };
}

const initialActive = (root) => {
  const active = [];
  let current = root;
  while (current) {
    active.push(current.id);
    current = current.composite ? current.children.get(current.def.initial) : null;
  }
  return active;
};

export function createMachine(definition, options = {}) {
  if (!isPlainObject(options)) {
    badMachine('options 必须是对象');
  }
  const { root, nodes } = buildTree(definition);

  if (options.context !== undefined && !isPlainObject(options.context)) {
    badMachine('context 必须是对象');
  }
  const baseContext = options.context === undefined ? {} : { ...options.context };

  let active = initialActive(root);
  let context = { ...baseContext };
  const queue = [];
  const history = new Map();

  const snapshot = () => ({
    active: [...active],
    context: { ...context },
    done: active.some((id) => nodes.get(id).def.final === true),
    queued: [...queue],
  });

  const whenMatches = (when) => {
    if (!when) {
      return true;
    }
    return Object.entries(when).every(([key, value]) => Object.is(context[key], value));
  };

  // 从当前最深叶子往上找：第一个写了该事件的状态先算，数组里第一个 when 满足的先算。
  const selectTransition = (eventName) => {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      const node = nodes.get(active[index]);
      const list = node.transitions.get(eventName);
      if (!list) {
        continue;
      }
      const transition = list.find((candidate) => whenMatches(candidate.when));
      return transition ? { source: node, transition } : { source: node, transition: null };
    }
    return null;
  };

  // 执行一条转换，返回这一步产生的退/进记录。
  const takeTransition = (source, transition) => {
    const trace = [];
    const target = nodes.get(transition.target);

    // LCA 的父状态就是 keep；LCA 本身是根时 keep 就是根（根永不退出）。
    let depth = 0;
    const maxDepth = Math.min(source.path.length, target.path.length);
    while (depth < maxDepth && source.path[depth] === target.path[depth]) {
      depth += 1;
    }
    const lca = nodes.get(source.path[depth - 1]);
    const keep = lca === root ? root : lca.parent;

    const oldLeaf = active[active.length - 1];

    // 退出：keep 以下的活跃状态从内到外逐个退；退到带 history 的复合状态时记下当时的叶子。
    for (let index = active.length - 1; index > keep.path.length - 1; index -= 1) {
      const exiting = nodes.get(active[index]);
      if (exiting.def.history === true) {
        history.set(exiting.id, oldLeaf);
      }
      trace.push({ type: 'exit', state: exiting.id });
    }

    // assign 在退出做完之后、进入之前浅合并。
    if (transition.assign) {
      context = { ...context, ...transition.assign };
    }

    // 进入：target 到 keep 之间（不含 keep）从外到内进。
    const entered = [];
    const segment = [];
    let current = target;
    while (current !== keep) {
      segment.push(current);
      current = current.parent;
    }
    segment.reverse();
    for (const entering of segment) {
      entered.push(entering.id);
      trace.push({ type: 'enter', state: entering.id });
    }

    // 进完 target 再把它补到叶子：viaHistory 吃历史叶子，否则顺 initial 走。
    if (target.composite) {
      const remembered =
        transition.viaHistory && history.has(target.id)
          ? nodes.get(history.get(target.id))
          : null;
      if (remembered) {
        const deep = [];
        let node = remembered;
        while (node !== target) {
          deep.push(node);
          node = node.parent;
        }
        deep.reverse();
        for (const node of deep) {
          entered.push(node.id);
          trace.push({ type: 'enter', state: node.id });
        }
      } else {
        let node = target;
        while (node.composite) {
          node = node.children.get(node.def.initial);
          entered.push(node.id);
          trace.push({ type: 'enter', state: node.id });
        }
      }
    }

    active = [...keep.path, ...entered];
    return trace;
  };

  const assertEventName = (eventName) => {
    if (!isNonEmptyString(eventName)) {
      badEvent('事件名必须是非空字符串');
    }
  };

  const raise = (eventName) => {
    assertEventName(eventName);
    queue.push(eventName);
  };

  const send = (eventName) => {
    assertEventName(eventName);

    const handled = [];
    const trace = [];
    let externalMatched = false;
    let external = eventName;
    let steps = 0;

    // 先 FIFO 清内部队列，再处理外部事件；处理中新排进来的接在后面继续清。
    while (queue.length > 0 || external !== null) {
      let current;
      let isExternal = false;
      if (queue.length > 0) {
        current = queue.shift();
      } else {
        current = external;
        external = null;
        isExternal = true;
      }

      steps += 1;
      if (steps > DEFAULTS.maxSteps) {
        throw new StateflowError(
          'ERR_TOO_MANY_EVENTS',
          `一轮处理的事件超过 ${DEFAULTS.maxSteps} 个`,
        );
      }

      handled.push(current);
      const picked = selectTransition(current);
      const matched = Boolean(picked && picked.transition);
      if (picked && picked.transition) {
        trace.push(...takeTransition(picked.source, picked.transition));
      }
      if (isExternal) {
        externalMatched = matched;
      }
    }

    return { matched: externalMatched, handled, trace, ...snapshot() };
  };

  const reset = () => {
    active = initialActive(root);
    context = { ...baseContext };
    queue.length = 0;
    history.clear();
    return snapshot();
  };

  return { state: snapshot, send, raise, reset };
}

export function run(definition, events, options = {}) {
  if (!Array.isArray(events)) {
    badEvent('run 的 events 必须是数组');
  }
  const machine = createMachine(definition, options);
  const results = events.map((eventName) => machine.send(eventName));
  const handled = results.flatMap((result) => result.handled);
  return { results, handled, ...machine.state() };
}
