// 可控的假 loader：每次回源按 plan 里的下一条来，plan 用完了就返回一个默认值。
//
//   loader.plan([{ value: 'v1', ttlMs: 1000 }, { hold: true }, { error: new Error('x') }])
//   loader.calls            // 每次真回源都会记一条 key，长度就是回源次数
//   loader.held             // 挂起中的那些（{ hold: true }），用例自己决定什么时候放行
//   loader.release(0, { value: 'v' })
//   loader.fail(0, new Error('boom'))
export function createFakeLoader() {
  const plan = [];
  const calls = [];
  const held = [];

  function normalize(item) {
    if (item.notFound) return { found: false };
    return { found: true, value: item.value, ttlMs: item.ttlMs };
  }

  return {
    calls,
    held,
    plan(items) {
      plan.push(...items);
    },
    release(index, item = {}) {
      held[index].resolve(normalize(item));
    },
    fail(index, error) {
      held[index].reject(error);
    },
    async load(key) {
      calls.push(key);
      const item = plan.length > 0 ? plan.shift() : { value: { key } };
      if (item.hold) {
        return new Promise((resolve, reject) => {
          held.push({
            key,
            resolve: (result) => resolve(normalize(result)),
            reject: (error) => reject(error),
          });
        });
      }
      if (item.error) throw item.error;
      return normalize(item);
    },
  };
}
