// 依赖版本求解。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/solve|conflict|pins）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）、版本范围（lib/semver.js）
// 和包源（lib/registry.js）都已经按 README 的《口径》和《API》两节写好了。
// 那些约定不要改，把这里补出来。

import { SolveError } from './errors.js';
import { isVersion, parseRange, satisfies, sortVersionsDesc } from './semver.js';

export const DEFAULTS = {
  maxBacktracks: 200, // 回退次数上限，超了报 ERR_TOO_MANY_BACKTRACKS
};

const badInput = (field, details = {}) =>
  new SolveError('ERR_BAD_INPUT', `入参形状不对：${field}`, { field, ...details });

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function resolveDeps(input = {}) {
  if (!isPlainObject(input)) throw badInput('input');
  const { registry } = input;
  if (
    !isPlainObject(registry) ||
    typeof registry.has !== 'function' ||
    typeof registry.versions !== 'function' ||
    typeof registry.deps !== 'function'
  ) {
    throw badInput('registry');
  }
  const { root } = input;
  if (!isPlainObject(root)) throw badInput('root');
  if (typeof root.name !== 'string' || root.name === '') throw badInput('root');
  if (!isVersion(root.version)) throw badInput('root');
  if (!isPlainObject(root.deps)) throw badInput('root.deps');
  for (const [pkg, range] of Object.entries(root.deps)) {
    if (typeof range !== 'string') throw badInput('deps', { pkg });
  }
  const pins = input.pins ?? {};
  if (!isPlainObject(pins)) throw badInput('pins');
  for (const [pkg, pin] of Object.entries(pins)) {
    if (!isVersion(pin)) throw badInput('pins', { pkg });
  }
  const maxBacktracks = input.maxBacktracks ?? DEFAULTS.maxBacktracks;
  if (!Number.isInteger(maxBacktracks) || maxBacktracks < 0) {
    throw badInput('maxBacktracks');
  }

  const rootFrom = `${root.name}@${root.version}`;
  const constraintsByPkg = new Map(); // pkg -> [{ from, range }]，按加进来的顺序
  const constraintKeys = new Set(); // `${from}\n${pkg}\n${range}`，同一条只算一次
  const decided = new Map(); // pkg -> 选中的版本
  const stats = { considered: 0, backtracks: 0, constraints: 0 };
  let firstFailure = null; // 最先卡住的那个包，留到 ERR_UNSATISFIED 用

  // 加一条约束；重复的不再记。范围、包名、钉版本的冲突都在这里拦。
  const addConstraint = (pkg, range, from) => {
    try {
      parseRange(range);
    } catch {
      throw new SolveError('ERR_BAD_RANGE', `看不懂 ${from} 对 ${pkg} 提的范围：${range}`, {
        pkg,
        range,
        from,
      });
    }
    if (!registry.has(pkg)) {
      const known = (constraintsByPkg.get(pkg) ?? []).map((item) => item.from);
      throw new SolveError('ERR_UNKNOWN_PACKAGE', `包源里没有 ${pkg}`, {
        pkg,
        from: [...known, from],
      });
    }
    if (Object.hasOwn(pins, pkg)) {
      const pin = pins[pkg];
      if (!registry.versions(pkg).includes(pin)) {
        throw new SolveError('ERR_NO_SUCH_VERSION', `${pkg} 没有钉住的版本 ${pin}`, {
          pkg,
          pin,
          versions: sortVersionsDesc(registry.versions(pkg)),
        });
      }
      if (!satisfies(range, pin)) {
        throw new SolveError(
          'ERR_PIN_CONFLICT',
          `${pkg} 钉在 ${pin}，满足不了 ${from} 提的 ${range}`,
          { pkg, pin, range, from },
        );
      }
    }
    const key = `${from}\n${pkg}\n${range}`;
    if (constraintKeys.has(key)) return false;
    constraintKeys.add(key);
    if (!constraintsByPkg.has(pkg)) constraintsByPkg.set(pkg, []);
    constraintsByPkg.get(pkg).push({ from, range });
    return true;
  };

  for (const pkg of Object.keys(root.deps).sort()) {
    addConstraint(pkg, root.deps[pkg], rootFrom);
  }

  // 钉住的包候选只有钉的那一档；其余取满足全部约束的版本，从高到低。
  const candidatesFor = (pkg) => {
    if (Object.hasOwn(pins, pkg)) return [pins[pkg]];
    const constraints = constraintsByPkg.get(pkg);
    return sortVersionsDesc(
      registry
        .versions(pkg)
        .filter((version) => constraints.every((item) => satisfies(item.range, version))),
    );
  };

  const recordFailure = (pkg) => {
    if (firstFailure) return;
    firstFailure = {
      pkg,
      chain: constraintsByPkg.get(pkg).map((item) => ({ from: item.from, range: item.range })),
      versions: candidatesFor(pkg),
    };
  };

  const smallestPending = () => {
    let best = null;
    for (const pkg of constraintsByPkg.keys()) {
      if (decided.has(pkg)) continue;
      if (best === null || pkg < best) best = pkg;
    }
    return best;
  };

  // 新加进来的约束会不会把某个已经定下来的包逼死。
  const stillConsistent = (touched) => {
    for (const pkg of touched) {
      if (!decided.has(pkg)) continue;
      const version = decided.get(pkg);
      const ok = constraintsByPkg
        .get(pkg)
        .every((item) => satisfies(item.range, version));
      if (!ok) {
        if (candidatesFor(pkg).length === 0) recordFailure(pkg);
        return false;
      }
    }
    return true;
  };

  const search = () => {
    const pkg = smallestPending();
    if (pkg === null) return true;
    const candidates = candidatesFor(pkg);
    if (candidates.length === 0) {
      recordFailure(pkg);
      return false;
    }
    for (let index = 0; index < candidates.length; index += 1) {
      if (index > 0) {
        stats.backtracks += 1;
        if (stats.backtracks > maxBacktracks) {
          throw new SolveError('ERR_TOO_MANY_BACKTRACKS', `回退次数超过 ${maxBacktracks}`, {
            maxBacktracks,
            backtracks: stats.backtracks,
          });
        }
      }
      const version = candidates[index];
      stats.considered += 1;
      decided.set(pkg, version);
      const from = `${pkg}@${version}`;
      const added = [];
      const deps = registry.deps(pkg, version) ?? {};
      for (const dep of Object.keys(deps).sort()) {
        if (addConstraint(dep, deps[dep], from)) {
          added.push([dep, `${from}\n${dep}\n${deps[dep]}`]);
        }
      }
      const touched = added.map(([dep]) => dep);
      if (stillConsistent(touched) && search()) return true;
      // 走不通就干干净净撤掉：这层加的约束一条不留，再换下一个低版本。
      for (const [dep, key] of added) {
        constraintKeys.delete(key);
        const list = constraintsByPkg.get(dep);
        list.pop();
        if (list.length === 0) constraintsByPkg.delete(dep);
      }
      decided.delete(pkg);
    }
    return false;
  };

  if (!search()) {
    const failure = firstFailure ?? {
      pkg: smallestPending() ?? Object.keys(root.deps).sort()[0],
      chain: [],
      versions: [],
    };
    throw new SolveError('ERR_UNSATISFIED', `${failure.pkg} 的约束怎么都凑不齐`, failure);
  }

  // 安装顺序：依赖排在依赖它的人前面，同层按名字升序；成环的按名字接在最后。
  const installOrder = () => {
    const names = [...decided.keys()];
    const selected = new Set(names);
    const indegree = new Map(names.map((name) => [name, 0]));
    const dependents = new Map(names.map((name) => [name, []]));
    for (const [pkg, version] of decided) {
      for (const dep of Object.keys(registry.deps(pkg, version) ?? {})) {
        if (!selected.has(dep)) continue;
        indegree.set(pkg, indegree.get(pkg) + 1);
        dependents.get(dep).push(pkg);
      }
    }
    const ready = names.filter((name) => indegree.get(name) === 0).sort();
    const order = [];
    while (ready.length > 0) {
      const node = ready.shift();
      order.push(node);
      for (const dependent of dependents.get(node)) {
        indegree.set(dependent, indegree.get(dependent) - 1);
        if (indegree.get(dependent) === 0) {
          ready.push(dependent);
          ready.sort();
        }
      }
    }
    const cyclic = names.filter((name) => !order.includes(name)).sort();
    return [...order, ...cyclic];
  };

  const packages = Object.fromEntries(
    [...decided.entries()].sort(([left], [right]) => (left < right ? -1 : 1)),
  );
  stats.constraints = constraintKeys.size;
  return { packages, order: installOrder(), stats };
}
