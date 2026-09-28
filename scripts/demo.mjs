import { canonicalRequest, presign, sign, UNSIGNED_PAYLOAD, DEFAULTS } from '../lib/reqsign.js';

const request = {
  method: 'post',
  path: '/v1/items/中文 name',
  query: { b: '2', a: ['1', '3'], empty: '', star: '*' },
  headers: {
    Host: 'api.example.com',
    'Content-Type': 'text/plain; charset=utf-8',
    Authorization: 'this one is not signed',
    'X-Trace': ['t2', 't1'],
  },
  payload: 'hello',
  credentials: {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
    region: 'cn-north-1',
    service: 'demo',
  },
  timestamp: '2013-05-24T00:00:00Z',
};

const line = (label, value) => console.log(`  ${label} ${value}`);

console.log('reqsign demo');
line('canonical', JSON.stringify(canonicalRequest(request)));

const signed = sign(request);
line('signedHeaders', signed.signedHeaders);
line('scope', signed.scope);
line('stringToSign', JSON.stringify(signed.stringToSign));
line('signature', signed.signature);
line('authorization', signed.authorization);

const pre = presign(request);
line('presignUrl', pre.url);
line('presignSignature', pre.signature);
line('presignExpires', String(pre.expires));

line('unsignedPayload', UNSIGNED_PAYLOAD);
line('maxExpires', String(DEFAULTS.maxExpires));
