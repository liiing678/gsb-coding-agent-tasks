import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { canonicalRequest, UNSIGNED_PAYLOAD } from '../lib/reqsign.js';
import { code, emptyHash } from './util.js';

const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

test('规范请求是那几行，编码、排序、头的规范化都要对', () => {
  const canonical = canonicalRequest({
    method: 'get',
    path: '/a b/中文/e',
    query: { b: '2', a: ['1', '3'], flag: '', 'a b': '*' },
    headers: {
      Host: 'example.com',
      'X-Amz-Date': '20130524T000000Z',
      'Content-Type': '  text/plain\t; charset=utf-8 ',
    },
    payload: 'hello',
  });
  assert.equal(canonical, [
    'GET',
    '/a%20b/%E4%B8%AD%E6%96%87/e',
    'a=1&a=3&a%20b=%2A&b=2&flag=',
    'content-type:text/plain ; charset=utf-8',
    'host:example.com',
    'x-amz-date:20130524T000000Z',
    '',
    'content-type;host;x-amz-date',
    hash('hello'),
  ].join('\n'));
});

test('不签的头当没看见，同一个头写两遍就连起来', () => {
  const canonical = canonicalRequest({
    method: 'PUT',
    path: '/',
    headers: {
      host: 'a.example.com',
      Host: 'b.example.com',
      Authorization: 'AKIDEXAMPLE:whatever',
      'user-agent': 'curl/8',
      'X-Trace': ['t2', 't1'],
    },
  });
  assert.deepEqual(canonical.split('\n'), [
    'PUT',
    '/',
    '',
    'host:a.example.com,b.example.com',
    'x-trace:t2,t1',
    '',
    'host;x-trace',
    emptyHash,
  ]);
});

test('正文不给按空串算，UNSIGNED-PAYLOAD 原样写进去', () => {
  const bare = canonicalRequest({ method: 'get', path: '/', headers: { host: 'x' } });
  assert.equal(bare.split('\n').at(-1), emptyHash);
  const unsigned = canonicalRequest({
    method: 'get',
    path: '/',
    headers: { host: 'x' },
    payload: UNSIGNED_PAYLOAD,
  });
  assert.equal(unsigned.split('\n').at(-1), 'UNSIGNED-PAYLOAD');
});

test('保留字符、空路径和空段的处理', () => {
  const canonical = canonicalRequest({
    method: 'get',
    path: '//a~b.c_d-e!',
    query: { 'a~b.c_d-e': 'x*y(z)' },
    headers: { host: 'x' },
  });
  assert.deepEqual(canonical.split('\n').slice(1, 3), [
    '//a~b.c_d-e%21',
    'a~b.c_d-e=x%2Ay%28z%29',
  ]);
  assert.equal(canonicalRequest({ method: 'get', headers: { host: 'x' } }).split('\n')[1], '/');
  assert.equal(canonicalRequest({ method: 'get', path: '', headers: { host: 'x' } }).split('\n')[1],
    '/');
});

test('请求形状不对各有各的码', () => {
  const base = { method: 'get', headers: { host: 'x' } };
  assert.equal(code(() => canonicalRequest(null)), 'ERR_BAD_REQUEST');
  assert.equal(code(() => canonicalRequest({ ...base, method: '' })), 'ERR_BAD_REQUEST');
  assert.equal(code(() => canonicalRequest({ ...base, method: 7 })), 'ERR_BAD_REQUEST');
  assert.equal(code(() => canonicalRequest({ ...base, path: 'a/b' })), 'ERR_BAD_REQUEST');
  assert.equal(code(() => canonicalRequest({ ...base, path: 7 })), 'ERR_BAD_REQUEST');
  assert.equal(code(() => canonicalRequest({ ...base, query: 'a=1' })), 'ERR_BAD_REQUEST');
  assert.equal(code(() => canonicalRequest({ ...base, query: { a: 7 } })), 'ERR_BAD_REQUEST');
  assert.equal(code(() => canonicalRequest({ ...base, headers: undefined })), 'ERR_BAD_REQUEST');
  assert.equal(code(() => canonicalRequest({ method: 'get', headers: { 'x-trace': 't' } })),
    'ERR_BAD_REQUEST');
  assert.equal(code(() => canonicalRequest({ ...base, headers: { host: 7 } })), 'ERR_BAD_REQUEST');
  assert.equal(code(() => canonicalRequest({ ...base, payload: 7 })), 'ERR_BAD_REQUEST');
});
