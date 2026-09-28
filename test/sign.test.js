import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import { ALGORITHM, canonicalRequest, DEFAULTS, presign, sign } from '../lib/reqsign.js';
import { code, credentials, request } from './util.js';

const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const hmac = (key, text) => createHmac('sha256', key).update(text, 'utf8').digest();

// 用例这边自己按 README 里那串 HMAC 再算一遍，不跟着实现走。
const manualKey = (date) => hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date),
  credentials.region), credentials.service), 'aws4_request');

test('签名跟手算的 HMAC 链对得上，Authorization 也拼得对', () => {
  const signed = sign(request);
  assert.equal(signed.canonicalRequest, canonicalRequest(request));
  assert.equal(signed.stringToSign, [
    ALGORITHM,
    '20130524T000000Z',
    '20130524/cn-north-1/demo/aws4_request',
    hash(signed.canonicalRequest),
  ].join('\n'));
  assert.equal(signed.signature, hmac(manualKey('20130524'), signed.stringToSign).toString('hex'));
  assert.equal(signed.authorization,
    `${ALGORITHM} Credential=AKIDEXAMPLE/20130524/cn-north-1/demo/aws4_request, `
    + `SignedHeaders=${signed.signedHeaders}, Signature=${signed.signature}`);
  assert.equal(signed.signedHeaders, 'content-type;host;x-trace');
  assert.equal(signed.scope, '20130524/cn-north-1/demo/aws4_request');
  assert.equal(signed.payloadHash, hash('hello'));
  assert.equal(signed.method, 'POST');
  assert.equal(signed.path, '/v1/items/%E4%B8%AD%E6%96%87%20name');
});

test('同一个请求签两遍一模一样，动一处就变', () => {
  const once = sign(request).signature;
  assert.equal(sign(request).signature, once);
  assert.notEqual(sign({ ...request, path: '/v1/items/other' }).signature, once);
  assert.notEqual(sign({ ...request, payload: 'hello!' }).signature, once);
  assert.notEqual(sign({ ...request, timestamp: '2013-05-24T00:00:01Z' }).signature, once);
  assert.notEqual(sign({ ...request, query: { ...request.query, b: '3' } }).signature, once);
});

test('timestamp 收 Date、epoch 毫秒和带时区的串', () => {
  const fromString = sign(request);
  assert.equal(sign({ ...request, timestamp: new Date('2013-05-24T00:00:00Z') }).signature,
    fromString.signature);
  assert.equal(sign({ ...request, timestamp: 1369353600000 }).signature, fromString.signature);
  assert.equal(sign({ ...request, timestamp: '2013-05-24T08:00:00+08:00' }).signature,
    fromString.signature);
  assert.equal(code(() => sign({ ...request, timestamp: 'nope' })), 'ERR_BAD_TIMESTAMP');
  assert.equal(code(() => sign({ ...request, timestamp: undefined })), 'ERR_BAD_TIMESTAMP');
  assert.equal(code(() => sign({ ...request, timestamp: new Date('nope') })), 'ERR_BAD_TIMESTAMP');
});

test('预签名 URL 把 X-Amz 那几条排进查询串，签名加在最后', () => {
  const pre = presign(request);
  const parts = pre.query.split('&');
  assert.equal(parts.at(-1), `X-Amz-Signature=${pre.signature}`);
  assert.deepEqual(parts.slice(0, 8), [
    'X-Amz-Algorithm=AWS4-HMAC-SHA256',
    'X-Amz-Credential=AKIDEXAMPLE%2F20130524%2Fcn-north-1%2Fdemo%2Faws4_request',
    'X-Amz-Date=20130524T000000Z',
    'X-Amz-Expires=604800',
    'X-Amz-SignedHeaders=content-type%3Bhost%3Bx-trace',
    'a=1',
    'a=3',
    'b=2',
  ]);
  assert.equal(pre.payloadHash, 'UNSIGNED-PAYLOAD');
  assert.equal(pre.url, `${pre.path}?${pre.query}`);
  assert.equal(pre.path, '/v1/items/%E4%B8%AD%E6%96%87%20name');
  assert.ok(pre.canonicalRequest.includes('X-Amz-SignedHeaders=content-type%3Bhost%3Bx-trace'));
  // 规范请求里放的是去掉签名的那串查询，签名本身不进去
  assert.ok(!pre.canonicalRequest.includes('X-Amz-Signature'));
  assert.equal(pre.canonicalRequest.split('\n')[2],
    pre.query.split('&').slice(0, -1).join('&'));
  assert.equal(pre.signature, hmac(manualKey('20130524'), pre.stringToSign).toString('hex'));
  assert.equal(pre.expires, DEFAULTS.maxExpires);
});

test('预签名的 expires 有范围，错误码分得开', () => {
  const short = presign({ ...request, expires: 60 });
  assert.equal(short.expires, 60);
  assert.ok(short.query.includes('X-Amz-Expires=60'));
  assert.equal(code(() => presign({ ...request, expires: 0 })), 'ERR_BAD_ARGS');
  assert.equal(code(() => presign({ ...request, expires: 1.5 })), 'ERR_BAD_ARGS');
  assert.equal(code(() => presign({ ...request, expires: DEFAULTS.maxExpires + 1 })),
    'ERR_BAD_ARGS');
  assert.equal(code(() => sign({ ...request, credentials: { ...credentials, region: '' } })),
    'ERR_BAD_CREDENTIALS');
  assert.equal(code(() => sign({ ...request, credentials: 'nope' })), 'ERR_BAD_CREDENTIALS');
});
