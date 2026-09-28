// 依赖版本求解：按名字择版、走不通就退档，并把冲突是谁逼出来的说清楚。

import {
  parseRange,
  satisfies,
  isVersion,
  sortVersionsDesc,
} from './semver.js';
import { SolveError } from './errors.js';

export const DEFAULTS = {
  maxBacktracks: 200, // 回退次数上限，超了报 ERR_TOO_MANY_BACKTRACKS
};

function fail(code, message, details = {}) {
  throw new SolveError(code, message, details);
}

export function resolveDeps(input = {}) {
  if (input === null || typeof input !== 'object') fail('ERR_BAD_INPUT', '入参得是个对象');
  const { registry, root, pins = {}, maxBacktracks = DEFAULTS.maxBacktracks } = input;

  validateInput({ registry, root, pins, maxBacktracks });

  const rootId = `${root.name}@${root.version}`;

  // pkg -> [{ from, range, parsed }]，顺序即加进来的顺序。
  const constraints = new Map();
  // pkg -> version，已定版的包。
  const decided = new Map();
  // (from -> pkg -> 范围原文) 去重：同一请求方对同一包的同一条范围只算一条。
  const seen = new Map();

  const stats = { considered: 0, backtracks: 0, constraints: 0 };

  const addConstraint = (pkg, range, from) => {
    let parsed;
    try {
      parsed = parseRange(range);
    } catch {
      fail('ERR_BAD_RANGE', `不认识的版本范围：${range}`, { pkg, range, from });
    }

    let byPkg = seen.get(from);
    if (!byPkg) {
      byPkg = new Map();
      seen.set(from, byPkg);
    }
    let ranges = byPkg.get(pkg);
    if (!ranges) {
      ranges = new Set();
      byPkg.set(pkg, ranges);
    }
    if (ranges.has(range)) return null;
    ranges.add(range);

    const item = { from, range, parsed };
    if (!constraints.has(pkg)) constraints.set(pkg, []);
    constraints.get(pkg).push(item);
    stats.constraints += 1;

    const pin = pins[pkg];
    if (pin !== undefined) {
      if (!registry.has(pkg) || !registry.versions(pkg).includes(pin)) {
        fail('ERR_NO_SUCH_VERSION', `钉住的 ${pkg}@${pin} 在包源里没有`, {
          pkg,
          pin,
          versions: registry.has(pkg) ? sortVersionsDesc(registry.versions(pkg)) : [],
        });
      }
      if (!satisfies(parsed, pin)) {
        fail('ERR_PIN_CONFLICT', `钉住的 ${pkg}@${pin} 不满足 ${from} 的 ${range}`, {
          pkg,
          pin,
          range,
          from,
        });
      }
    }
    return item;
  };

  const removeConstraint = (pkg, item) => {
    const list = constraints.get(pkg);
    if (!list) return;
    const index = list.indexOf(item);
    if (index >= 0) {
      list.splice(index, 1);
      stats.constraints -= 1;
      if (list.length === 0) constraints.delete(pkg);
    }
  };

  // 加完约束后，已经定版的包是否还扛得住；扛不住就该退档了。
  const checkDecided = () => {
    for (const [pkg, version] of decided) {
      const list = constraints.get(pkg);
      if (list && list.some((item) => !satisfies(item.parsed, version))) return pkg;
    }
    return null;
  };

  // 留着走到最深那一步的失败现场，方便说明是谁卡住的。
  let deepest = null;
  const recordConflict = (pkg) => {
    const list = constraints.get(pkg) ?? [];
    if (
      !deepest ||
      decided.size > deepest.depth ||
      (decided.size === deepest.depth && deepest.pkg > pkg)
    ) {
      deepest = {
        pkg,
        depth: decided.size,
        chain: list.map((item) => ({ from: item.from, range: item.range })),
        versions: candidatesOf(pkg),
      };
    }
  };

  const candidatesOf = (pkg) => {
    const list = constraints.get(pkg) ?? [];
    if (!registry.has(pkg)) return [];
    const pin = pins[pkg];
    let versions = registry.versions(pkg);
    if (pin !== undefined) versions = versions.includes(pin) ? [pin] : [];
    return sortVersionsDesc(versions).filter((version) =>
      list.every((item) => satisfies(item.parsed, version)),
    );
  };

  const solve = () => {
    while (true) {
      const pending = [...constraints.keys()]
        .filter((pkg) => !decided.has(pkg))
        .sort();

      if (pending.length === 0) return true;

      const pkg = pending[0];

      if (!registry.has(pkg)) {
        const from = [...new Set((constraints.get(pkg) ?? []).map((item) => item.from))];
        fail('ERR_UNKNOWN_PACKAGE', `包源里没有 ${pkg}`, { pkg, from });
      }

      const candidates = candidatesOf(pkg);
      if (candidates.length === 0) {
        recordConflict(pkg);
        return false;
      }

      for (const version of candidates) {
        stats.considered += 1;
        decided.set(pkg, version);

        const added = [];
        const deps = registry.deps(pkg, version);
        for (const [depPkg, range] of Object.entries(deps)) {
          const item = addConstraint(depPkg, range, `${pkg}@${version}`);
          if (item) added.push({ pkg: depPkg, item });
        }

        const violated = checkDecided();
        if (violated === null && solve()) return true;

        if (violated !== null) recordConflict(violated);

        for (const entry of added) removeConstraint(entry.pkg, entry.item);

        stats.backtracks += 1;
        if (stats.backtracks > maxBacktracks) {
          fail('ERR_TOO_MANY_BACKTRACKS', `回退次数超过上限 ${maxBacktracks}`, {
            maxBacktracks,
            backtracks: stats.backtracks,
          });
        }
      }

      decided.delete(pkg);
      return false;
    }
  };

  for (const [pkg, range] of Object.entries(root.deps)) {
    addConstraint(pkg, range, rootId);
  }

  if (!solve()) {
    const where = deepest ?? { pkg: '(unknown)', chain: [], versions: [] };
    fail('ERR_UNSATISFIED', `${where.pkg} 的版本约束没法同时满足`, {
      pkg: where.pkg,
      chain: where.chain,
      versions: where.versions,
    });
  }

  const packages = Object.fromEntries([...decided.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  return {
    packages,
    order: installOrder(packages, registry),
    stats,
  };
}

// 依赖排在依赖它的人前面，同层按名字升序；成环的包最后按名字接上。
function installOrder(packages, registry) {
  const names = Object.keys(packages).sort();
  const remaining = new Set(names);
  const order = [];

  while (remaining.size > 0) {
    const ready = names.filter(
      (name) =>
        remaining.has(name) &&
        Object.keys(registry.deps(name, packages[name])).every((dep) => !remaining.has(dep)),
    );
    for (const name of ready) {
      order.push(name);
      remaining.delete(name);
    }
    if (ready.length === 0) {
      for (const name of names) {
        if (remaining.has(name)) {
          order.push(name);
          remaining.delete(name);
        }
      }
    }
  }

  return order;
}

function validateInput({ registry, root, pins, maxBacktracks }) {
  if (!registry || typeof registry !== 'object') {
    fail('ERR_BAD_INPUT', 'registry 不能为空', { field: 'registry' });
  }
  for (const method of ['has', 'versions', 'deps']) {
    if (typeof registry[method] !== 'function') {
      fail('ERR_BAD_INPUT', `registry.${method} 得是个函数`, { field: 'registry' });
    }
  }

  if (!root || typeof root !== 'object') {
    fail('ERR_BAD_INPUT', 'root 得是个对象', { field: 'root' });
  }
  if (typeof root.name !== 'string' || root.name === '') {
    fail('ERR_BAD_INPUT', 'root.name 得是非空字符串', { field: 'root.name' });
  }
  if (!isVersion(root.version)) {
    fail('ERR_BAD_INPUT', 'root.version 得写成 x.y.z', { field: 'root.version' });
  }
  if (!root.deps || typeof root.deps !== 'object' || Array.isArray(root.deps)) {
    fail('ERR_BAD_INPUT', 'root.deps 得是个对象', { field: 'deps' });
  }
  for (const [pkg, range] of Object.entries(root.deps)) {
    if (typeof pkg !== 'string' || pkg === '') {
      fail('ERR_BAD_INPUT', '依赖名得是非空字符串', { field: 'deps', pkg });
    }
    if (typeof range !== 'string') {
      fail('ERR_BAD_INPUT', `依赖 ${pkg} 的范围得是字符串`, { field: 'deps', pkg });
    }
  }

  if (pins !== null && (typeof pins !== 'object' || Array.isArray(pins))) {
    fail('ERR_BAD_INPUT', 'pins 得是个对象', { field: 'pins' });
  }
  for (const [pkg, version] of Object.entries(pins)) {
    if (!isVersion(version)) {
      fail('ERR_BAD_INPUT', `钉住的 ${pkg} 版本得写成 x.y.z`, { field: 'pins', pkg });
    }
  }

  if (
    typeof maxBacktracks !== 'number' ||
    !Number.isInteger(maxBacktracks) ||
    maxBacktracks < 0
  ) {
    fail('ERR_BAD_INPUT', 'maxBacktracks 得是非负整数', { field: 'maxBacktracks' });
  }

}
