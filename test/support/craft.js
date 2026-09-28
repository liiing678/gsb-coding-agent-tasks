import crypto from 'node:crypto';

function b64url(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

// 按 README 里写死的线格式手工造一张令牌。
// 用来验「跟外面约好的格式」，以及那些 issue() 造不出来的情况（比如 iat 跑到未来）。
export function craftToken({ kid, secret, payload, alg = 'HS256' }) {
  const header = { alg, typ: 'JWT', kid };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

export function decodeSegment(token, index) {
  return JSON.parse(Buffer.from(token.split('.')[index], 'base64url').toString('utf8'));
}

export function accessPayload({ iss, sub = 'u1', sid = 's1', jti = 'j1', iat, ttlMs }) {
  return { iss, sub, sid, typ: 'access', jti, iat, exp: iat + ttlMs };
}
