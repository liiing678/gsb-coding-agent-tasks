// 请求签名：规范请求、派生签名密钥与预签名 URL。
//
// 这个文件是仓库里唯一还没实现的部分：用例（test/canonical.test.js、test/sign.test.js）、
// 演示脚本（scripts/demo.mjs）、错误码（lib/errors.js）都已经按 README 的《口径》和《API》
// 两节写好了。那些约定不要改，把这里补出来。

import { createHash, createHmac } from 'node:crypto';

import { ReqsignError } from './errors.js';

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const ALGORITHM = 'AWS4-HMAC-SHA256';

export const DEFAULTS = {
  maxExpires: 604800,
  unsigned: ['authorization', 'user-agent'],
};

const UNSIGNED_HEADERS = new Set(DEFAULTS.unsigned);

const badRequest = (message) => new ReqsignError('ERR_BAD_REQUEST', message);
const badCredentials = (message) => new ReqsignError('ERR_BAD_CREDENTIALS', message);
const badTimestamp = (message) => new ReqsignError('ERR_BAD_TIMESTAMP', message);
const badArgs = (message) => new ReqsignError('ERR_BAD_ARGS', message);

const isObject = (value) => typeof value === 'object'
  && value !== null
  && !Array.isArray(value);

const compareText = (left, right) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const encodeComponent = (value) => encodeURIComponent(value)
  .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

const encodePath = (path) => path.split('/').map(encodeComponent).join('/');

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

const hmacBytes = (key, value) => createHmac('sha256', key)
  .update(value, 'utf8')
  .digest();

const normalizeHeaderValue = (value) => value.trim().replace(/\s+/g, ' ');

const normalizeQueryPairs = (query) => {
  if (query !== undefined && !isObject(query)) {
    throw badRequest('query must be an object');
  }

  const pairs = [];
  for (const [name, rawValue] of Object.entries(query ?? {})) {
    let values;
    if (rawValue === null || rawValue === undefined) {
      values = [''];
    } else if (typeof rawValue === 'string') {
      values = [rawValue];
    } else if (Array.isArray(rawValue)) {
      values = rawValue.map((value) => {
        if (value === null || value === undefined) return '';
        if (typeof value !== 'string') {
          throw badRequest('query values must be strings');
        }
        return value;
      });
    } else {
      throw badRequest('query values must be strings or arrays of strings');
    }

    for (const value of values) {
      pairs.push({
        name: encodeComponent(name),
        value: encodeComponent(value),
      });
    }
  }

  pairs.sort((left, right) => compareText(left.name, right.name)
    || compareText(left.value, right.value));
  return pairs;
};

const renderQuery = (pairs) => pairs
  .map(({ name, value }) => `${name}=${value}`)
  .join('&');

const normalizeHeaders = (headers) => {
  if (!isObject(headers)) {
    throw badRequest('headers must be an object');
  }

  const valuesByName = new Map();
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (UNSIGNED_HEADERS.has(name)) continue;

    let values;
    if (rawValue === null) {
      values = [''];
    } else if (typeof rawValue === 'string') {
      values = [rawValue];
    } else if (Array.isArray(rawValue)) {
      if (!rawValue.every((value) => typeof value === 'string')) {
        throw badRequest('header values must be strings');
      }
      values = rawValue;
    } else {
      throw badRequest('header values must be strings or arrays of strings');
    }

    const normalized = values.map(normalizeHeaderValue);
    valuesByName.set(name, (valuesByName.get(name) ?? []).concat(normalized));
  }

  if (!valuesByName.has('host')) {
    throw badRequest('headers must include host');
  }

  const names = [...valuesByName.keys()].sort(compareText);
  return {
    names,
    lines: names.map((name) => `${name}:${valuesByName.get(name).join(',')}`),
    signedHeaders: names.join(';'),
  };
};

const prepareRequest = (request, { unsignedPayload = false } = {}) => {
  if (!isObject(request)) {
    throw badRequest('request must be an object');
  }
  if (typeof request.method !== 'string' || request.method.length === 0) {
    throw badRequest('method must be a non-empty string');
  }
  if (request.path !== undefined && request.path !== ''
    && (typeof request.path !== 'string' || !request.path.startsWith('/'))) {
    throw badRequest('path must be a string starting with /');
  }

  const method = request.method.toUpperCase();
  const rawPath = request.path === undefined || request.path === '' ? '/' : request.path;
  const path = encodePath(rawPath);
  const queryPairs = normalizeQueryPairs(request.query);
  const canonicalQuery = renderQuery(queryPairs);
  const headers = normalizeHeaders(request.headers);

  let payloadHash;
  if (unsignedPayload) {
    payloadHash = UNSIGNED_PAYLOAD;
  } else if (request.payload === undefined) {
    payloadHash = sha256('');
  } else if (typeof request.payload === 'string') {
    payloadHash = request.payload === UNSIGNED_PAYLOAD
      ? UNSIGNED_PAYLOAD
      : sha256(request.payload);
  } else {
    throw badRequest('payload must be a string');
  }

  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    ...headers.lines,
    '',
    headers.signedHeaders,
    payloadHash,
  ].join('\n');

  return {
    method,
    path,
    queryPairs,
    canonicalQuery,
    headers: headers.lines,
    signedHeaders: headers.signedHeaders,
    payloadHash,
    canonicalRequest,
  };
};

const validateCredentials = (credentials) => {
  if (!isObject(credentials)) {
    throw badCredentials('credentials must be an object');
  }

  for (const field of ['accessKeyId', 'secretAccessKey', 'region', 'service']) {
    if (typeof credentials[field] !== 'string' || credentials[field].length === 0) {
      throw badCredentials(`${field} must be a non-empty string`);
    }
  }

  return credentials;
};

const pad = (value, length = 2) => String(value).padStart(length, '0');

const parseTimestamp = (timestamp) => {
  let date;
  if (timestamp instanceof Date) {
    date = timestamp;
  } else if (typeof timestamp === 'number') {
    if (!Number.isFinite(timestamp)) {
      throw badTimestamp('timestamp must be a valid time');
    }
    date = new Date(timestamp);
  } else if (typeof timestamp === 'string') {
    date = new Date(timestamp);
  } else {
    throw badTimestamp('timestamp must be a Date, number, or parseable string');
  }

  if (Number.isNaN(date.getTime())) {
    throw badTimestamp('timestamp must be a valid time');
  }

  const amzDate = `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}`
    + `${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`
    + `${pad(date.getUTCSeconds())}Z`;

  return {
    amzDate,
    date: amzDate.slice(0, 8),
  };
};

const buildSigningKey = (secretAccessKey, date, region, service) => {
  let key = Buffer.from(`AWS4${secretAccessKey}`, 'utf8');
  for (const data of [date, region, service, 'aws4_request']) {
    key = hmacBytes(key, data);
  }
  return key;
};

const buildSignatureMaterial = (request, prepared) => {
  const credentials = validateCredentials(request.credentials);
  const timestamp = parseTimestamp(request.timestamp);
  const scope = `${timestamp.date}/${credentials.region}/${credentials.service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    timestamp.amzDate,
    scope,
    sha256(prepared.canonicalRequest),
  ].join('\n');
  const signingKey = buildSigningKey(
    credentials.secretAccessKey,
    timestamp.date,
    credentials.region,
    credentials.service,
  );
  const signature = hmacBytes(signingKey, stringToSign).toString('hex');

  return {
    credentials,
    timestamp,
    scope,
    stringToSign,
    signature,
  };
};

export function canonicalRequest(request) {
  return prepareRequest(request).canonicalRequest;
}

export function sign(request) {
  const prepared = prepareRequest(request);
  const material = buildSignatureMaterial(request, prepared);

  return {
    method: prepared.method,
    path: prepared.path,
    query: prepared.canonicalQuery,
    payloadHash: prepared.payloadHash,
    signedHeaders: prepared.signedHeaders,
    scope: material.scope,
    canonicalRequest: prepared.canonicalRequest,
    stringToSign: material.stringToSign,
    signature: material.signature,
    authorization: `${ALGORITHM} Credential=${material.credentials.accessKeyId}/`
      + `${material.scope}, SignedHeaders=${prepared.signedHeaders}, `
      + `Signature=${material.signature}`,
  };
}

export function presign(request) {
  let expires = request?.expires;
  if (expires === undefined) {
    expires = DEFAULTS.maxExpires;
  } else if (!Number.isInteger(expires) || expires <= 0 || expires > DEFAULTS.maxExpires) {
    throw badArgs(`expires must be a positive integer no greater than ${DEFAULTS.maxExpires}`);
  }

  const prepared = prepareRequest(request, { unsignedPayload: true });
  const material = buildSignatureMaterial(request, prepared);
  const queryPairs = [...prepared.queryPairs];

  for (const [name, value] of [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${material.credentials.accessKeyId}/${material.scope}`],
    ['X-Amz-Date', material.timestamp.amzDate],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', prepared.signedHeaders],
  ]) {
    queryPairs.push({
      name: encodeComponent(name),
      value: encodeComponent(value),
    });
  }

  queryPairs.sort((left, right) => compareText(left.name, right.name)
    || compareText(left.value, right.value));

  const canonicalQuery = renderQuery(queryPairs);
  const canonical = [
    prepared.method,
    prepared.path,
    canonicalQuery,
    ...prepared.headers,
    '',
    prepared.signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [
    ALGORITHM,
    material.timestamp.amzDate,
    material.scope,
    sha256(canonical),
  ].join('\n');
  const signingKey = buildSigningKey(
    material.credentials.secretAccessKey,
    material.timestamp.date,
    material.credentials.region,
    material.credentials.service,
  );
  const signature = hmacBytes(signingKey, stringToSign).toString('hex');
  const query = `${canonicalQuery}&X-Amz-Signature=${signature}`;

  return {
    url: `${prepared.path}?${query}`,
    query,
    path: prepared.path,
    signedHeaders: prepared.signedHeaders,
    payloadHash: UNSIGNED_PAYLOAD,
    scope: material.scope,
    canonicalRequest: canonical,
    stringToSign,
    signature,
    expires,
  };
}
