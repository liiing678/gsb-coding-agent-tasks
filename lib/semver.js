// 版本号和版本范围。版本号只认 x.y.z 三段数字（这个项目里没有预发布版本）。

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export class SemverError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SemverError';
    this.code = code;
    this.details = details;
  }
}

export function parseVersion(text) {
  const matched = typeof text === 'string' ? VERSION_RE.exec(text) : null;
  if (!matched) {
    throw new SemverError('ERR_BAD_VERSION', `版本号要写成 x.y.z：${text}`, { version: text });
  }
  return { major: Number(matched[1]), minor: Number(matched[2]), patch: Number(matched[3]) };
}

export function isVersion(text) {
  return typeof text === 'string' && VERSION_RE.test(text);
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

// 从高到低排，同一个数组里的版本号互不相同。
export function sortVersionsDesc(versions) {
  return [...versions].sort((left, right) => compareVersions(right, left));
}

const ANY = { groups: [[]] };

// 解析成"或"的组：groups 里任意一组成立就算满足，组内是若干个比较器（都要成立）。
export function parseRange(text) {
  if (typeof text !== 'string') throw badRange(text);
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'X') return ANY;
  const groups = [];
  for (const part of trimmed.split('||')) {
    const token = part.trim();
    if (token === '') throw badRange(text);
    groups.push(parseGroup(token, text));
  }
  return { groups };
}

export function validRange(text) {
  try {
    parseRange(text);
    return true;
  } catch {
    return false;
  }
}

export function satisfies(range, version) {
  const parsed = typeof range === 'string' ? parseRange(range) : range;
  const target = parseVersion(version);
  for (const group of parsed.groups) {
    if (group.every((item) => compareWith(item, target) === true)) return true;
  }
  return false;
}

function compareWith(item, target) {
  const diff =
    target.major - item.version.major ||
    target.minor - item.version.minor ||
    target.patch - item.version.patch;
  switch (item.op) {
    case '>=':
      return diff >= 0;
    case '>':
      return diff > 0;
    case '<=':
      return diff <= 0;
    case '<':
      return diff < 0;
    case '=':
      return diff === 0;
    default:
      return false;
  }
}

function parseGroup(token, whole) {
  const items = [];
  for (const piece of token.split(/\s+/)) {
    const matched = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(piece);
    const op = matched[1] ?? '';
    const rest = matched[2].trim();
    if (rest === '') {
      if (op === '') continue;
      throw badRange(whole);
    }
    if (op === '^') {
      const base = parseVersionOrPartial(rest, whole);
      items.push({ op: '>=', version: base });
      items.push({ op: '<', version: caretUpper(base) });
      continue;
    }
    if (op === '~') {
      const base = parseVersionOrPartial(rest, whole);
      items.push({ op: '>=', version: base });
      items.push({ op: '<', version: tildeUpper(base, rest) });
      continue;
    }
    const wildcard = wildcardBounds(rest);
    if (wildcard) {
      if (op !== '' && op !== '=') throw badRange(whole);
      items.push(...wildcard);
      continue;
    }
    let version;
    try {
      version = parseVersion(rest);
    } catch {
      throw badRange(whole);
    }
    items.push({ op: op === '' ? '=' : op, version });
  }
  if (items.length === 0) throw badRange(whole);
  return items;
}

// ^1.2.3 -> <2.0.0，^0.2.3 -> <0.3.0，^0.0.3 -> <0.0.4
function caretUpper(base) {
  if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0 };
  if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: base.patch + 1 };
}

// ~1.2.3 / ~1.2 -> <1.3.0，~1 -> <2.0.0
function tildeUpper(base, written) {
  const parts = written.split('.');
  if (parts.length === 1) return { major: base.major + 1, minor: 0, patch: 0 };
  return { major: base.major, minor: base.minor + 1, patch: 0 };
}

// 1.2.x -> >=1.2.0 <1.3.0，1.x -> >=1.0.0 <2.0.0
function wildcardBounds(text) {
  const two = /^(\d+)\.(\d+)\.[xX*]$/.exec(text);
  if (two) {
    const major = Number(two[1]);
    const minor = Number(two[2]);
    return [
      { op: '>=', version: { major, minor, patch: 0 } },
      { op: '<', version: { major, minor: minor + 1, patch: 0 } },
    ];
  }
  const one = /^(\d+)\.[xX*]$/.exec(text);
  if (one) {
    const major = Number(one[1]);
    return [
      { op: '>=', version: { major, minor: 0, patch: 0 } },
      { op: '<', version: { major: major + 1, minor: 0, patch: 0 } },
    ];
  }
  return null;
}

// ^ / ~ 后面可以少写段数：^1 -> 1.0.0，~1.2 -> 1.2.0
function parseVersionOrPartial(text, whole) {
  const parts = text.split('.');
  if (parts.length > 3 || parts.length === 0) throw badRange(whole);
  if (parts.some((part) => part !== '' && !/^\d+$/.test(part))) throw badRange(whole);
  const [major = '0', minor = '0', patch = '0'] = parts.map((part) => (part === '' ? '0' : part));
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

function badRange(text) {
  return new SemverError('ERR_BAD_RANGE', `不认识的版本范围：${text}`, { range: text });
}
