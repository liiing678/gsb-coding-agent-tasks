// 内存里的包源：包名 -> 版本 -> 这个版本自己的依赖。
// 求解之外的事（去重、候选排序、回溯）都不在这里。
export function createRegistry(input = {}) {
  const packages = new Map();
  for (const [name, entry] of Object.entries(input.packages ?? {})) {
    const versions = new Map();
    for (const [version, spec] of Object.entries(entry.versions ?? {})) {
      versions.set(version, { deps: { ...(spec.deps ?? {}) } });
    }
    packages.set(name, versions);
  }
  return {
    has: (name) => packages.has(name),
    names: () => [...packages.keys()],
    versions(name) {
      return packages.has(name) ? [...packages.get(name).keys()] : [];
    },
    deps(name, version) {
      const found = packages.get(name)?.get(version);
      return found ? { ...found.deps } : null;
    },
  };
}
