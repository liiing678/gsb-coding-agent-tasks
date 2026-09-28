import { createNode } from '../lib/raftlog.js';

export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

// 一个只有消息在传的小集群：deliver 把消息喂给收件人，收件人回什么就原样吐出来。
export const cluster = (ids = ['a', 'b', 'c'], options = {}) => {
  const nodes = new Map(ids.map((id) => [id, createNode({
    id,
    members: ids,
    term: options.term ?? 1,
    leader: id === (options.leader ?? ids[0]),
  })]));
  const deliver = (messages) => {
    const out = [];
    for (const message of messages) {
      const target = nodes.get(message.to);
      if (target) {
        out.push(...target.step(message));
      }
    }
    return out;
  };
  return { nodes, deliver };
};
