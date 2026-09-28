// 这个文件就是要写的那块。现在它只会抛 NotImplementedError。
//
// createTokenService({ config, metrics, keys, now, random })
//   -> { issue, refresh, verify, revoke, reloadKeys, snapshot }
//
//   config  : configs/dev.json 里 tokens 那一段（已经校验过）
//   metrics : src/metrics.js 的计数器，名字见 README
//   keys    : src/keys.js 归一化过的密钥集合（[{ kid, secret, state, verifyUntilMs }]）
//   now     : 取当前时间的函数，默认 () => Date.now()；测试会塞假时钟
//   random  : 取随机数的函数，默认 Math.random；测试会塞定种子的伪随机
//
// 令牌长什么样、每步的 code、计数器怎么算，README 的「口径」那几节里都写了。

import crypto from 'node:crypto';

import { TokenError } from './errors.js';
import { findKey, normalizeKeys, signingKey } from './keys.js';

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export function createTokenService({
  config,
  metrics,
  keys,
  now = () => Date.now(),
  random = Math.random,
} = {}) {
  let currentKeys = keys;
  const sessions = new Map(); // sid -> { sub, refreshJti, refreshExpiresAt }
  const revocations = new Map(); // "jti:<jti>" / "sid:<sid>" -> 已含容差的截止时间
  let idSequence = 0;

  function newId(prefix) {
    idSequence += 1;
    const chunk = () =>
      (Math.floor(random() * 0x100000000) % 0x100000000)
        .toString(16)
        .padStart(8, '0');
    return `${prefix}_${idSequence.toString(36)}_${chunk()}${chunk()}`;
  }

  // 每次进服务顺手收敛内存：会话留到 refresh exp + 容差，撤销条目留到写好的截止时间。
  function sweep() {
    const t = now();
    for (const [sid, session] of sessions) {
      if (t > session.refreshExpiresAt + config.clockSkewMs) {
        sessions.delete(sid);
      }
    }
    for (const [key, expiresAt] of revocations) {
      if (t > expiresAt) {
        revocations.delete(key);
      }
    }
  }

  function encodeSegment(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  }

  // base64url 不带 padding；长度、字符集、回写对不上都算解不开。
  function decodeSegment(segment) {
    if (
      typeof segment !== 'string' ||
      segment.length === 0 ||
      segment.length % 4 === 1 ||
      !/^[A-Za-z0-9_-]+$/.test(segment)
    ) {
      throw new TokenError('invalid_token');
    }
    const buffer = Buffer.from(segment, 'base64url');
    if (buffer.toString('base64url') !== segment) {
      throw new TokenError('invalid_token');
    }
    return buffer;
  }

  function sign(key, signingInput) {
    return crypto
      .createHmac('sha256', key.secret)
      .update(signingInput)
      .digest('base64url');
  }

  function mintPair(sub, sid, iat) {
    const key = signingKey(currentKeys);
    const mint = (typ, ttlMs) => {
      const payload = {
        iss: config.issuer,
        sub,
        sid,
        typ,
        jti: newId(typ),
        iat,
        exp: iat + ttlMs,
      };
      const header = { alg: 'HS256', typ: 'JWT', kid: key.kid };
      const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
      return { token: `${signingInput}.${sign(key, signingInput)}`, payload };
    };
    return {
      access: mint('access', config.accessTtlMs),
      refresh: mint('refresh', config.refreshTtlMs),
    };
  }

  // verify 的第 1..5 步：格式、alg、kid、密钥过渡期、签名、issuer。
  function authenticate(token) {
    if (typeof token !== 'string') {
      throw new TokenError('invalid_token');
    }
    const segments = token.split('.');
    if (segments.length !== 3) {
      throw new TokenError('invalid_token');
    }
    const [headerSegment, payloadSegment, signatureSegment] = segments;
    const signature = decodeSegment(signatureSegment);
    let header;
    let claims;
    try {
      header = JSON.parse(decodeSegment(headerSegment).toString('utf8'));
      claims = JSON.parse(decodeSegment(payloadSegment).toString('utf8'));
    } catch {
      throw new TokenError('invalid_token');
    }
    if (
      header === null ||
      typeof header !== 'object' ||
      claims === null ||
      typeof claims !== 'object'
    ) {
      throw new TokenError('invalid_token');
    }
    if (header.alg !== 'HS256') {
      throw new TokenError('invalid_token');
    }
    const key = findKey(currentKeys, header.kid);
    if (key === null) {
      throw new TokenError('unknown_kid');
    }
    if (
      key.state === 'verifyOnly' &&
      key.verifyUntilMs !== null &&
      now() > key.verifyUntilMs
    ) {
      throw new TokenError('key_expired');
    }
    const expected = crypto
      .createHmac('sha256', key.secret)
      .update(`${headerSegment}.${payloadSegment}`)
      .digest();
    if (
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(signature, expected)
    ) {
      throw new TokenError('bad_signature');
    }
    if (claims.iss !== config.issuer) {
      throw new TokenError('wrong_issuer');
    }
    return { header, claims };
  }

  function invalidateSession(sid, session) {
    // 重放触发的会话作废不走容量校验：安全口径优先，条目随会话 refresh 到期一起清。
    revocations.set(`sid:${sid}`, session.refreshExpiresAt + config.clockSkewMs);
  }

  return {
    issue({ sub } = {}) {
      sweep();
      if (typeof sub !== 'string' || sub === '') {
        throw new TokenError('invalid_request');
      }
      const iat = now();
      const sid = newId('sid');
      const { access, refresh } = mintPair(sub, sid, iat);
      sessions.set(sid, {
        sub,
        refreshJti: refresh.payload.jti,
        refreshExpiresAt: refresh.payload.exp,
      });
      metrics.inc('access_issued_total');
      metrics.inc('refresh_issued_total');
      return {
        accessToken: access.token,
        refreshToken: refresh.token,
        sid,
        accessExpiresAt: access.payload.exp,
        refreshExpiresAt: refresh.payload.exp,
      };
    },
    refresh({ refreshToken } = {}) {
      sweep();
      // 先看令牌本身（第 1..8 步），再看会话状态；自己过期报 expired，不碰会话。
      const { claims } = authenticate(refreshToken);
      if (claims.typ !== 'refresh') {
        throw new TokenError('wrong_typ');
      }
      const t = now();
      if (claims.iat > t + config.clockSkewMs) {
        throw new TokenError('not_yet_valid');
      }
      if (t > claims.exp + config.clockSkewMs) {
        throw new TokenError('expired');
      }

      const session = sessions.get(claims.sid);
      if (!session) {
        throw new TokenError('session_revoked');
      }
      if (revocations.has(`jti:${claims.jti}`)) {
        throw new TokenError('revoked');
      }
      if (revocations.has(`sid:${claims.sid}`)) {
        throw new TokenError('session_revoked');
      }
      if (claims.jti !== session.refreshJti) {
        // 当前会话认的是另一张更新的 refresh：这张是被换掉的，重放。
        // 整条会话立刻作废，已经发出去的 access 也一起不认。
        metrics.inc('refresh_replayed_total');
        metrics.inc('session_revoked_total');
        invalidateSession(claims.sid, session);
        throw new TokenError('refresh_replayed');
      }

      const iat = now();
      const { access, refresh } = mintPair(session.sub, claims.sid, iat);
      session.refreshJti = refresh.payload.jti;
      session.refreshExpiresAt = refresh.payload.exp;
      metrics.inc('refresh_ok_total');
      metrics.inc('access_issued_total');
      metrics.inc('refresh_issued_total');
      return {
        accessToken: access.token,
        refreshToken: refresh.token,
        sid: claims.sid,
        accessExpiresAt: access.payload.exp,
        refreshExpiresAt: refresh.payload.exp,
      };
    },
    verify(token, { typ = 'access' } = {}) {
      sweep();
      try {
        const { claims } = authenticate(token);
        const t = now();
        if (claims.typ !== typ) {
          throw new TokenError('wrong_typ');
        }
        if (claims.iat > t + config.clockSkewMs) {
          throw new TokenError('not_yet_valid');
        }
        if (t > claims.exp + config.clockSkewMs) {
          throw new TokenError('expired');
        }
        if (revocations.has(`jti:${claims.jti}`)) {
          throw new TokenError('revoked');
        }
        if (revocations.has(`sid:${claims.sid}`)) {
          throw new TokenError('session_revoked');
        }
        metrics.inc('verify_ok_total');
        return claims;
      } catch (error) {
        if (error instanceof TokenError) {
          metrics.inc('verify_rejected_total');
        }
        throw error;
      }
    },
    revoke({ token, scope = 'token' } = {}) {
      sweep();
      if (scope !== 'token' && scope !== 'session') {
        throw new TokenError('invalid_request');
      }
      // 只过前 5 步：格式、kid、密钥可用性、签名、issuer。
      const { claims } = authenticate(token);
      const t = now();

      if (scope === 'token') {
        if (t > claims.exp + config.clockSkewMs) {
          metrics.inc('revoke_skipped_total');
          return { revoked: false, scope, reason: 'expired' };
        }
        const key = `jti:${claims.jti}`;
        if (
          !revocations.has(key) &&
          revocations.size >= config.revocationCapacity
        ) {
          metrics.inc('revocation_rejected_total');
          throw new TokenError('revocation_capacity_exceeded');
        }
        // 截止时间已经含容差，清理时直接跟 now() 比，不再加第二遍。
        revocations.set(key, claims.exp + config.clockSkewMs);
        metrics.inc('token_revoked_total');
        return { revoked: true, scope };
      }

      const session = sessions.get(claims.sid);
      if (!session) {
        throw new TokenError('session_revoked');
      }
      if (t > session.refreshExpiresAt + config.clockSkewMs) {
        metrics.inc('revoke_skipped_total');
        return { revoked: false, scope, reason: 'expired' };
      }
      const key = `sid:${claims.sid}`;
      if (
        !revocations.has(key) &&
        revocations.size >= config.revocationCapacity
      ) {
        metrics.inc('revocation_rejected_total');
        throw new TokenError('revocation_capacity_exceeded');
      }
      revocations.set(key, session.refreshExpiresAt + config.clockSkewMs);
      metrics.inc('session_revoked_total');
      return { revoked: true, scope };
    },
    reloadKeys(rawKeys) {
      currentKeys = normalizeKeys(rawKeys);
    },
    snapshot() {
      return {
        signingKid: signingKey(currentKeys).kid,
        sessions: sessions.size,
        revocations: revocations.size,
        counters: metrics.snapshot(),
      };
    },
    get keys() {
      return currentKeys;
    },
  };
}
