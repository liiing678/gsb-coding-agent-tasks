// CIDR 前缀表内核：地址/前缀解析、最长前缀匹配、按值聚合。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/prefix.test.js、test/table.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import { CidrError } from './errors.js';

const TOTAL_BITS = { 4: 32, 6: 128 };

const fail = (code, message, details) => {
  throw new CidrError(code, message, details);
};

// IPv4：四段十进制，每段 0-255，不写前导零。
const parseV4 = (text) => {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
};

const parseV6Half = (text) => {
  if (text === '') return [];
  const groups = [];
  for (const part of text.split(':')) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    groups.push(Number(`0x${part}`));
  }
  return groups;
};

// IPv6：标准写法，最多一次 `::` 且至少省掉一组，不认内嵌 IPv4。
const parseV6 = (text) => {
  if (text.includes('.')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  if (halves.length === 1) {
    const groups = parseV6Half(halves[0]);
    return groups && groups.length === 8 ? groups : null;
  }
  const left = parseV6Half(halves[0]);
  const right = parseV6Half(halves[1]);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array(missing).fill(0), ...right];
};

export function parseAddress(text) {
  if (typeof text !== 'string' || text.length === 0 || /\s/.test(text)) {
    fail('ERR_BAD_ADDRESS', `地址必须是非空且不含空白的字符串: ${String(text)}`);
  }
  if (text.includes(':')) {
    const groups = parseV6(text);
    if (!groups) fail('ERR_BAD_ADDRESS', `IPv6 地址写法不合法: ${text}`);
    let value = 0n;
    for (const group of groups) value = (value << 16n) | BigInt(group);
    return { family: 6, value };
  }
  const value = parseV4(text);
  if (value === null) fail('ERR_BAD_ADDRESS', `IPv4 地址写法不合法: ${text}`);
  return { family: 4, value };
}

const maskFor = (family, bits) => {
  if (bits === 0) return 0n;
  return ((1n << BigInt(bits)) - 1n) << BigInt(TOTAL_BITS[family] - bits);
};

// 严格模式下主机位必须是 0；宽松模式（查询类方法）直接掩掉主机位再查。
const finalizePrefix = (family, bits, value, allowHostBits) => {
  const network = value & maskFor(family, bits);
  if (!allowHostBits && network !== value) {
    fail('ERR_BAD_PREFIX', `前缀的主机位必须是 0: ${formatAddress(family, value)}/${bits}`);
  }
  return { family, bits, value: network, text: `${formatAddress(family, network)}/${bits}` };
};

const parsePrefixInternal = (input, allowHostBits) => {
  if (typeof input === 'string') {
    if (input.length === 0 || /\s/.test(input)) {
      fail('ERR_BAD_PREFIX', `前缀必须是非空且不含空白的字符串: ${input}`);
    }
    const parts = input.split('/');
    if (parts.length !== 2) fail('ERR_BAD_PREFIX', `前缀要写成 地址/长度: ${input}`);
    const [addressText, bitsText] = parts;
    if (!/^(0|[1-9][0-9]*)$/.test(bitsText)) {
      fail('ERR_BAD_PREFIX', `掩码长度不是不带前导零的十进制: ${input}`);
    }
    let address;
    try {
      address = parseAddress(addressText);
    } catch {
      fail('ERR_BAD_PREFIX', `前缀里的地址不合法: ${input}`);
    }
    const bits = Number(bitsText);
    if (bits > TOTAL_BITS[address.family]) {
      fail('ERR_BAD_PREFIX', `掩码长度超出 IPv${address.family} 的上限: ${input}`);
    }
    return finalizePrefix(address.family, bits, address.value, allowHostBits);
  }
  if (input !== null && typeof input === 'object') {
    const { family, bits, value } = input;
    const shapeOk = (family === 4 || family === 6)
      && Number.isInteger(bits) && bits >= 0 && bits <= TOTAL_BITS[family]
      && typeof value === 'bigint' && value >= 0n
      && value < (1n << BigInt(TOTAL_BITS[family]));
    if (!shapeOk) fail('ERR_BAD_PREFIX', '前缀对象形状不对', { input });
    return finalizePrefix(family, bits, value, allowHostBits);
  }
  fail('ERR_BAD_PREFIX', `前缀必须是字符串或 parsePrefix 的返回值: ${String(input)}`);
};

export const parsePrefix = (input) => parsePrefixInternal(input, false);

const formatV6 = (value) => {
  const groups = [];
  for (let i = 7; i >= 0; i--) {
    groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  }
  // RFC 5952：最长的一段连续全零组写成 ::，一样长取靠左的那段。
  let bestStart = -1;
  let bestLength = 0;
  let i = 0;
  while (i < 8) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLength).join(':');
  return `${left}::${right}`;
};

export function formatAddress(family, value) {
  const valid = (family === 4 || family === 6)
    && typeof value === 'bigint' && value >= 0n
    && value < (1n << BigInt(TOTAL_BITS[family]));
  if (!valid) fail('ERR_BAD_ARGUMENT', 'formatAddress 需要 (4|6, 对应位宽的 BigInt)');
  if (family === 4) {
    const parts = [];
    for (let i = 3; i >= 0; i--) parts.push(String((value >> BigInt(i * 8)) & 0xffn));
    return parts.join('.');
  }
  return formatV6(value);
}

// 值相等的口径：规范化文本一样。对象按键名排序，数组保持顺序，NaN 算相等。
const canonical = (value) => {
  if (typeof value === 'number' && Number.isNaN(value)) return 'number:NaN';
  if (value === null || typeof value !== 'object') {
    const json = JSON.stringify(value);
    return `${typeof value}:${json === undefined ? String(value) : json}`;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};

const newNode = () => ({ children: [null, null], has: false, value: undefined });

export function createTable() {
  const roots = { 4: newNode(), 6: newNode() };
  let count = 0;

  const bitAt = (family, value, depth) =>
    Number((value >> BigInt(TOTAL_BITS[family] - 1 - depth)) & 1n);

  const walk = (family, value, bits, create) => {
    let node = roots[family];
    for (let depth = 0; depth < bits; depth++) {
      const bit = bitAt(family, value, depth);
      let next = node.children[bit];
      if (!next) {
        if (!create) return null;
        next = newNode();
        node.children[bit] = next;
      }
      node = next;
    }
    return node;
  };

  const insert = (prefixInput, value) => {
    if (value === undefined) fail('ERR_BAD_ARGUMENT', 'insert 必须给值（不能是 undefined）');
    const prefix = parsePrefix(prefixInput);
    const node = walk(prefix.family, prefix.value, prefix.bits, true);
    const replaced = node.has;
    if (!replaced) count++;
    node.has = true;
    node.value = value;
    return { prefix: prefix.text, replaced };
  };

  const exact = (prefixInput) => {
    const prefix = parsePrefixInternal(prefixInput, true);
    const node = walk(prefix.family, prefix.value, prefix.bits, false);
    if (!node || !node.has) return null;
    return { prefix: prefix.text, value: node.value };
  };

  const has = (prefixInput) => exact(prefixInput) !== null;

  const remove = (prefixInput) => {
    const prefix = parsePrefixInternal(prefixInput, true);
    const path = [];
    let node = roots[prefix.family];
    for (let depth = 0; depth < prefix.bits; depth++) {
      const bit = bitAt(prefix.family, prefix.value, depth);
      const next = node.children[bit];
      if (!next) return false;
      path.push([node, bit]);
      node = next;
    }
    if (!node.has) return false;
    node.has = false;
    node.value = undefined;
    count--;
    // 只剩空壳的中间节点顺手剪掉，有兄弟或有条目的节点要留住。
    for (let depth = path.length - 1; depth >= 0; depth--) {
      if (node.has || node.children[0] || node.children[1]) break;
      const [parent, bit] = path[depth];
      parent.children[bit] = null;
      node = parent;
    }
    return true;
  };

  const lookup = (addressInput) => {
    const address = parseAddress(addressInput);
    let node = roots[address.family];
    let best = node.has ? { bits: 0, node } : null;
    for (let depth = 0; depth < TOTAL_BITS[address.family]; depth++) {
      const bit = bitAt(address.family, address.value, depth);
      node = node.children[bit];
      if (!node) break;
      if (node.has) best = { bits: depth + 1, node };
    }
    if (!best) return null;
    const network = address.value & maskFor(address.family, best.bits);
    return {
      prefix: `${formatAddress(address.family, network)}/${best.bits}`,
      value: best.node.value,
    };
  };

  const size = () => count;

  const entries = () => {
    const found = [];
    const visit = (family, node, depth, network) => {
      if (node.has) found.push({ family, bits: depth, network, value: node.value });
      const shift = BigInt(TOTAL_BITS[family] - 1 - depth);
      for (const bit of [0, 1]) {
        const child = node.children[bit];
        if (child) visit(family, child, depth + 1, network | (BigInt(bit) << shift));
      }
    };
    visit(4, roots[4], 0, 0n);
    visit(6, roots[6], 0, 0n);
    found.sort((a, b) => a.family - b.family
      || (a.network < b.network ? -1 : a.network > b.network ? 1 : 0)
      || a.bits - b.bits);
    return found.map((entry) => ({
      prefix: `${formatAddress(entry.family, entry.network)}/${entry.bits}`,
      value: entry.value,
    }));
  };

  const aggregate = () => {
    const before = count;
    const merge = (node) => {
      for (const bit of [0, 1]) {
        if (node.children[bit]) merge(node.children[bit]);
      }
      const [zero, one] = node.children;
      if (!zero || !one) return;
      const isLeafEntry = (child) => child.has && !child.children[0] && !child.children[1];
      if (!isLeafEntry(zero) || !isLeafEntry(one)) return;
      if (canonical(zero.value) !== canonical(one.value)) return;
      if (node.has && canonical(node.value) !== canonical(zero.value)) return;
      count -= node.has ? 2 : 1;
      node.children = [null, null];
      node.has = true;
      node.value = zero.value;
    };
    merge(roots[4]);
    merge(roots[6]);
    return before - count;
  };

  return { insert, exact, has, remove, lookup, size, entries, aggregate };
}
