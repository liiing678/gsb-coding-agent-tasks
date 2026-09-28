// CIDR 前缀表内核：地址/前缀解析、最长前缀匹配、按值聚合。
//
// 口径见 README 的《口径》和《API》两节：地址是字符串（v4 四段十进制不写前导零，
// v6 标准写法、允许一次 ::、不认内嵌 v4），前缀主机位必须是 0，value 用 BigInt
// （v4 32 位、v6 128 位），IPv6 文本按 RFC 5952 压缩。出错一律抛 CidrError。

import { CidrError } from './errors.js';

const BITS = { 4: 32, 6: 128 };

const badAddress = (text) => {
  throw new CidrError('ERR_BAD_ADDRESS', `非法地址: ${String(text)}`, { input: text });
};

const badPrefix = (input) => {
  throw new CidrError('ERR_BAD_PREFIX', `非法前缀: ${String(input)}`, { input });
};

// 地址/前缀字符串：非空、任何位置都不能有空白。
const isCleanText = (text) =>
  typeof text === 'string' && text.length > 0 && !/\s/.test(text);

const parseV4 = (text) => {
  const parts = text.split('.');
  if (parts.length !== 4) badAddress(text);
  let value = 0n;
  for (const part of parts) {
    if (!/^(0|[1-9]\d*)$/.test(part)) badAddress(text);
    const n = Number(part);
    if (n > 255) badAddress(text);
    value = (value << 8n) | BigInt(n);
  }
  return { family: 4, value };
};

const parseV6 = (text) => {
  if (text.includes('.')) badAddress(text); // 不认内嵌 IPv4
  const halves = text.split('::');
  if (halves.length > 2) badAddress(text);
  const groups = (s) => {
    if (s === '') return [];
    return s.split(':').map((g) => {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) badAddress(text);
      return Number.parseInt(g, 16);
    });
  };
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const compressed = 8 - head.length - tail.length;
  // 有 :: 时至少要省掉一组；没有 :: 时必须正好八组。
  if (halves.length === 2 ? compressed < 1 : compressed !== 0) badAddress(text);
  const full = [...head, ...Array(compressed).fill(0), ...tail];
  let value = 0n;
  for (const g of full) value = (value << 16n) | BigInt(g);
  return { family: 6, value };
};

export function parseAddress(text) {
  if (!isCleanText(text)) badAddress(text);
  return text.includes(':') ? parseV6(text) : parseV4(text);
}

export function formatAddress(family, value) {
  if (family === 4) {
    const out = [];
    for (let i = 3; i >= 0; i--) out.push(String((value >> BigInt(i * 8)) & 0xffn));
    return out.join('.');
  }
  if (family !== 6) {
    throw new CidrError('ERR_BAD_ARGUMENT', `未知 family: ${family}`, { family });
  }
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  // RFC 5952：最长的一段连续全零组写成 ::，一样长取靠左的那段，单组不压缩。
  let bestStart = -1;
  let bestLen = 0;
  let i = 0;
  while (i < 8) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(':');
  const head = groups.slice(0, bestStart).map((g) => g.toString(16)).join(':');
  const tail = groups.slice(bestStart + bestLen).map((g) => g.toString(16)).join(':');
  return `${head}::${tail}`;
}

// 公共收尾：掩出网络地址、生成规范化文本。严格模式（parsePrefix / insert）
// 要求主机位本来就是 0；查询类方法（exact / has / remove）掩掉主机位再查。
const finishPrefix = (family, bits, value, original, allowHostBits) => {
  const max = BITS[family];
  if (value < 0n || value >= (1n << BigInt(max))) badPrefix(original);
  const hostMask = (1n << BigInt(max - bits)) - 1n;
  const network = value & ~hostMask;
  if (!allowHostBits && network !== value) badPrefix(original); // 主机位不是 0
  return { family, bits, value: network, text: `${formatAddress(family, network)}/${bits}` };
};

const parsePrefixInternal = (input, allowHostBits) => {
  if (typeof input === 'string') {
    if (!isCleanText(input)) badPrefix(input);
    const parts = input.split('/');
    if (parts.length !== 2) badPrefix(input);
    let addr;
    try {
      addr = parseAddress(parts[0]);
    } catch {
      badPrefix(input); // 地址的毛病在前缀接口上统一报 ERR_BAD_PREFIX
    }
    if (!/^(0|[1-9]\d*)$/.test(parts[1])) badPrefix(input);
    const bits = Number(parts[1]);
    if (bits > BITS[addr.family]) badPrefix(input);
    return finishPrefix(addr.family, bits, addr.value, input, allowHostBits);
  }
  if (input !== null && typeof input === 'object') {
    const { family, bits, value } = input;
    const ok =
      (family === 4 || family === 6) &&
      Number.isInteger(bits) &&
      bits >= 0 &&
      bits <= BITS[family] &&
      typeof value === 'bigint';
    if (!ok) badPrefix(input);
    return finishPrefix(family, bits, value, input, allowHostBits);
  }
  badPrefix(input);
};

export function parsePrefix(input) {
  return parsePrefixInternal(input, false);
}

// 值相等的口径：规范化文本一样。对象按键名排序、数组保持顺序、NaN 算相等。
const canonical = (value) => {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isNaN(value) ? 'num:NaN' : `num:${JSON.stringify(value)}`;
  if (t === 'bigint') return `big:${value}`;
  if (t === 'string') return `str:${JSON.stringify(value)}`;
  if (t === 'boolean') return `bool:${value}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return String(value);
};

const EMPTY = Symbol('empty');
const newNode = () => ({ child: [null, null], value: EMPTY });

export function createTable() {
  const roots = { 4: newNode(), 6: newNode() };
  let count = 0;

  const bitAt = (family, value, depth) =>
    Number((value >> BigInt(BITS[family] - 1 - depth)) & 1n);

  const insert = (prefix, value) => {
    const p = parsePrefix(prefix);
    if (value === undefined) {
      throw new CidrError('ERR_BAD_ARGUMENT', 'insert 需要一个值（不能是 undefined）');
    }
    let node = roots[p.family];
    for (let d = 0; d < p.bits; d++) {
      const b = bitAt(p.family, p.value, d);
      if (!node.child[b]) node.child[b] = newNode();
      node = node.child[b];
    }
    const replaced = node.value !== EMPTY;
    if (!replaced) count++;
    node.value = value;
    return { prefix: p.text, replaced };
  };

  const exact = (prefix) => {
    const p = parsePrefixInternal(prefix, true);
    let node = roots[p.family];
    for (let d = 0; d < p.bits; d++) {
      node = node.child[bitAt(p.family, p.value, d)];
      if (!node) return null;
    }
    return node.value !== EMPTY ? { prefix: p.text, value: node.value } : null;
  };

  const has = (prefix) => exact(prefix) !== null;

  const remove = (prefix) => {
    const p = parsePrefixInternal(prefix, true);
    const path = [roots[p.family]];
    for (let d = 0; d < p.bits; d++) {
      const next = path[d].child[bitAt(p.family, p.value, d)];
      if (!next) return false;
      path.push(next);
    }
    const node = path[p.bits];
    if (node.value === EMPTY) return false;
    node.value = EMPTY;
    count--;
    // 从叶子往上剪掉只剩空壳的节点，遇到还有条目或还有孩子的就停。
    for (let d = p.bits; d > 0; d--) {
      const n = path[d];
      if (n.value !== EMPTY || n.child[0] || n.child[1]) break;
      path[d - 1].child[bitAt(p.family, p.value, d - 1)] = null;
    }
    return true;
  };

  const lookup = (address) => {
    const a = parseAddress(address);
    let node = roots[a.family];
    let best = node.value !== EMPTY ? { bits: 0, value: node.value } : null;
    // 一路走到最深，记下沿途最后一个有条目的节点。
    for (let d = 0; d < BITS[a.family]; d++) {
      const next = node.child[bitAt(a.family, a.value, d)];
      if (!next) break;
      node = next;
      if (node.value !== EMPTY) best = { bits: d + 1, value: node.value };
    }
    if (!best) return null;
    const hostMask = (1n << BigInt(BITS[a.family] - best.bits)) - 1n;
    const network = a.value & ~hostMask;
    return { prefix: `${formatAddress(a.family, network)}/${best.bits}`, value: best.value };
  };

  const size = () => count;

  const entries = () => {
    const rows = [];
    for (const family of [4, 6]) {
      const max = BITS[family];
      const dfs = (node, value, bits) => {
        if (node.value !== EMPTY) rows.push({ family, value, bits, val: node.value });
        for (const b of [0, 1]) {
          if (node.child[b]) {
            dfs(node.child[b], value | (BigInt(b) << BigInt(max - 1 - bits)), bits + 1);
          }
        }
      };
      dfs(roots[family], 0n, 0);
    }
    rows.sort(
      (x, y) =>
        x.family - y.family ||
        (x.value < y.value ? -1 : x.value > y.value ? 1 : 0) ||
        x.bits - y.bits,
    );
    return rows.map((r) => ({
      prefix: `${formatAddress(r.family, r.value)}/${r.bits}`,
      value: r.val,
    }));
  };

  const aggregate = () => {
    const before = count;
    for (const family of [4, 6]) {
      let changed = true;
      while (changed) {
        changed = false;
        // 后序遍历：先合下面，合完回到父节点时正好接着往上试。
        const visit = (node) => {
          if (!node) return;
          visit(node.child[0]);
          visit(node.child[1]);
          const left = node.child[0];
          const right = node.child[1];
          const leafWithValue = (n) =>
            n && n.value !== EMPTY && !n.child[0] && !n.child[1];
          if (
            leafWithValue(left) &&
            leafWithValue(right) &&
            canonical(left.value) === canonical(right.value) &&
            (node.value === EMPTY || canonical(node.value) === canonical(left.value))
          ) {
            count -= node.value === EMPTY ? 1 : 2;
            node.value = left.value;
            node.child[0] = null;
            node.child[1] = null;
            changed = true;
          }
        };
        visit(roots[family]);
      }
    }
    return before - count;
  };

  return { insert, exact, has, remove, lookup, size, entries, aggregate };
}
