import { EgressError, ErrorKind } from '../../src/errors.js';

// 假上游：按脚本回答，顺带把假时钟往前推。
//
// 每条脚本是一个行为对象，或者一个吃 call 信息返回行为对象的函数：
//   { status, headers, body }        正常回一个响应（默认 200）
//   { timeout: true }                这次尝试一直不回来，超时（把当前尝试的超时吃满）
//   { connect: true }                连不上
//   { promise }                      挂住，等用例自己 resolve（用来造"在飞"的状态）
//   { durationMs }                   正常响应，但耗时这么多（推时钟）
// 脚本用完就重复最后一条。
export function createFakeUpstream({ clock }) {
  const plans = new Map();
  const calls = [];

  const transport = async (request, { timeoutMs }) => {
    const upstream = request.upstream;
    const list = plans.get(upstream) ?? [];
    const index = calls.filter((item) => item.upstream === upstream).length;
    const entry = list[Math.min(index, Math.max(list.length - 1, 0))];
    if (entry === undefined) {
      throw new Error(`假上游 ${upstream} 没有第 ${index + 1} 条脚本`);
    }

    const call = {
      upstream,
      attempt: index + 1,
      timeoutMs,
      at: clock.now(),
      method: request.method ?? 'GET',
      url: request.url,
      idempotent: request.idempotent,
    };
    calls.push(call);

    const behavior = typeof entry === 'function' ? entry(call) : entry;
    if (behavior.promise) {
      return behavior.promise;
    }
    if (behavior.timeout) {
      clock.advance(timeoutMs);
      throw new EgressError(ErrorKind.TIMEOUT, `假上游 ${upstream} 超时`, { upstream });
    }
    if (behavior.connect) {
      throw new EgressError(ErrorKind.CONNECT, `连不上假上游 ${upstream}`, { upstream });
    }
    if (behavior.durationMs) {
      clock.advance(behavior.durationMs);
    }
    return {
      status: behavior.status ?? 200,
      headers: behavior.headers ?? {},
      body: Buffer.from(behavior.body ?? '{}'),
    };
  };

  return {
    transport,
    calls,
    plan(upstream, list) {
      plans.set(upstream, list);
      return this;
    },
    hits(upstream) {
      return calls.filter((item) => item.upstream === upstream).length;
    },
  };
}
