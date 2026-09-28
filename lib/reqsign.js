// 请求签名：规范请求、派生签名密钥与预签名 URL。口径见 README 的《口径》和《API》。
import { createHash, createHmac } from 'node:crypto';

import { ReqsignError } from './errors.js';

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const ALGORITHM = 'AWS4-HMAC-SHA256';

export const DEFAULTS = {
  maxExpires: 604800,
  unsigned: ['authorization', 'user-agent'],
};

const fail = (code, message, details) => {
  throw new ReqsignError(code, message, details);
};

const sha256hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const hmac = (key, text) => createHmac('sha256', key).update(text, 'utf8').digest();

// 只留 A-Za-z0-9-._~，encodeURIComponent 漏掉的 !'()* 在这里补上。
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g,
  (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const asValues = (value, what) => {
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => {
    if (item === null || item === undefined) return '';
    if (typeof item !== 'string') {
      fail('ERR_BAD_REQUEST', `${what} 的值得是字符串`, { value: item });
    }
    return item;
  });
};

const normalizeHeaderValue = (value) => value.trim().replace(/[ \t\n]+/g, ' ');

// 名和值各自编码后排序：先比名，名一样再比值，重名的条目都留着。
const canonicalQuery = (entries) => {
  const pairs = entries.map(([name, value]) => [encode(name), encode(value)]);
  pairs.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
  return pairs.map(([name, value]) => `${name}=${value}`).join('&');
};

// 校验请求形状，返回规范化好的各个部件；不碰 credentials 和 timestamp。
const normalizeRequest = (request) => {
  if (!isObject(request)) fail('ERR_BAD_REQUEST', 'request 得是对象');

  const { method, path, query, headers, payload } = request;
  if (typeof method !== 'string' || method === '') {
    fail('ERR_BAD_REQUEST', 'method 得是非空字符串', { method });
  }

  let rawPath = path === undefined || path === '' ? '/' : path;
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) {
    fail('ERR_BAD_REQUEST', 'path 得以 / 开头', { path });
  }
  const encodedPath = rawPath.split('/').map(encode).join('/');

  if (query !== undefined && !isObject(query)) {
    fail('ERR_BAD_REQUEST', 'query 得是对象', { query });
  }
  const queryEntries = [];
  for (const [name, value] of Object.entries(query ?? {})) {
    for (const item of asValues(value, 'query')) queryEntries.push([name, item]);
  }

  if (!isObject(headers)) fail('ERR_BAD_REQUEST', 'headers 得是对象', { headers });
  const merged = new Map();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (DEFAULTS.unsigned.includes(lower)) continue;
    const values = asValues(value, 'headers').map(normalizeHeaderValue);
    if (!merged.has(lower)) merged.set(lower, []);
    merged.get(lower).push(...values);
  }
  if (!merged.has('host')) fail('ERR_BAD_REQUEST', 'headers 里必须有 host');
  const names = [...merged.keys()].sort();
  const headerLines = names.map((name) => `${name}:${merged.get(name).join(',')}`);
  const signedHeaders = names.join(';');

  let payloadHash;
  if (payload === undefined) payloadHash = sha256hex('');
  else if (payload === UNSIGNED_PAYLOAD) payloadHash = UNSIGNED_PAYLOAD;
  else if (typeof payload === 'string') payloadHash = sha256hex(payload);
  else fail('ERR_BAD_REQUEST', 'payload 得是字符串或 UNSIGNED-PAYLOAD', { payload });

  return {
    method: method.toUpperCase(),
    path: encodedPath,
    queryEntries,
    headerLines,
    signedHeaders,
    payloadHash,
  };
};

const buildCanonical = (parts, queryString, payloadHash) => [
  parts.method,
  parts.path,
  queryString,
  ...parts.headerLines,
  '',
  parts.signedHeaders,
  payloadHash,
].join('\n');

const checkCredentials = (credentials) => {
  if (!isObject(credentials)) fail('ERR_BAD_CREDENTIALS', 'credentials 得是对象');
  for (const key of ['accessKeyId', 'secretAccessKey', 'region', 'service']) {
    if (typeof credentials[key] !== 'string' || credentials[key] === '') {
      fail('ERR_BAD_CREDENTIALS', `credentials.${key} 得是非空字符串`);
    }
  }
  return credentials;
};

const pad = (n) => String(n).padStart(2, '0');

const parseTimestamp = (timestamp) => {
  if (timestamp === undefined || timestamp === null) {
    fail('ERR_BAD_TIMESTAMP', 'timestamp 没给');
  }
  let date;
  if (timestamp instanceof Date) date = timestamp;
  else if (typeof timestamp === 'number' || typeof timestamp === 'string') {
    date = new Date(timestamp);
  }
  if (!date || Number.isNaN(date.getTime())) {
    fail('ERR_BAD_TIMESTAMP', 'timestamp 解析不出合法时间', { timestamp });
  }
  const datePart = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  const timePart = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  return { amzDate: `${datePart}T${timePart}Z`, date: datePart };
};

// AWS4<secret> → date → region → service → aws4_request，每步喂上一步的字节。
const signingKey = (credentials, date) => hmac(
  hmac(
    hmac(
      hmac(`AWS4${credentials.secretAccessKey}`, date),
      credentials.region),
    credentials.service),
  'aws4_request');

const prepare = (request) => {
  const parts = normalizeRequest(request);
  const credentials = checkCredentials(request.credentials);
  const { amzDate, date } = parseTimestamp(request.timestamp);
  const scope = `${date}/${credentials.region}/${credentials.service}/aws4_request`;
  return { parts, credentials, amzDate, date, scope };
};

export function canonicalRequest(request) {
  const parts = normalizeRequest(request);
  return buildCanonical(parts, canonicalQuery(parts.queryEntries), parts.payloadHash);
}

export function sign(request) {
  const { parts, credentials, amzDate, date, scope } = prepare(request);
  const canonical = buildCanonical(parts, canonicalQuery(parts.queryEntries), parts.payloadHash);
  const stringToSign = [ALGORITHM, amzDate, scope, sha256hex(canonical)].join('\n');
  const signature = hmac(signingKey(credentials, date), stringToSign).toString('hex');
  const authorization = `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, `
    + `SignedHeaders=${parts.signedHeaders}, Signature=${signature}`;
  return {
    method: parts.method,
    path: parts.path,
    query: canonicalQuery(parts.queryEntries),
    payloadHash: parts.payloadHash,
    signedHeaders: parts.signedHeaders,
    scope,
    canonicalRequest: canonical,
    stringToSign,
    signature,
    authorization,
  };
}

export function presign(request) {
  const { parts, credentials, amzDate, date, scope } = prepare(request);

  const expires = request.expires === undefined ? DEFAULTS.maxExpires : request.expires;
  if (!Number.isInteger(expires) || expires <= 0 || expires > DEFAULTS.maxExpires) {
    fail('ERR_BAD_ARGS', `expires 得是不超过 ${DEFAULTS.maxExpires} 的正整数`, { expires });
  }

  const entries = [
    ...parts.queryEntries,
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${credentials.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', parts.signedHeaders],
  ];
  const sortedQuery = canonicalQuery(entries);
  const canonical = buildCanonical(parts, sortedQuery, UNSIGNED_PAYLOAD);
  const stringToSign = [ALGORITHM, amzDate, scope, sha256hex(canonical)].join('\n');
  const signature = hmac(signingKey(credentials, date), stringToSign).toString('hex');
  const query = `${sortedQuery}&X-Amz-Signature=${signature}`;
  return {
    url: `${parts.path}?${query}`,
    query,
    path: parts.path,
    signedHeaders: parts.signedHeaders,
    payloadHash: UNSIGNED_PAYLOAD,
    scope,
    canonicalRequest: canonical,
    stringToSign,
    signature,
    expires,
  };
}
