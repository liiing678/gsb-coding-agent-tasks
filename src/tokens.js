// 会话令牌服务。线格式、错误顺序和计数器口径见 README.md。
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
import { performance } from 'node:perf_hooks';

import { TokenError } from './errors.js';
import { findKey, normalizeKeys, signingKey } from './keys.js';

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

function systemNow() {
  return Math.round(performance.timeOrigin + performance.now());
}

function systemRandom() {
  return crypto.randomBytes(4).readUInt32BE() / 4294967296;
}

export function createTokenService({
  config,
  metrics,
  keys,
  now = systemNow,
  random = systemRandom,
} = {}) {
  let currentKeys = keys;
  const sessions = new Map();
  const revocations = new Map();
  let idSerial = 0;

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function generateId(prefix) {
    idSerial += 1;
    const randomPart = Array.from({ length: 2 }, () =>
      Math.floor(random() * 0x100000000)
        .toString(16)
        .padStart(8, '0'),
    ).join('');
    return `${prefix}_${idSerial.toString(36)}_${randomPart}`;
  }

  function sessionKey(sid) {
    return `sid:${sid}`;
  }

  function tokenKey(jti) {
    return `jti:${jti}`;
  }

  function cleanup() {
    const currentTime = now();
    for (const [sid, session] of sessions) {
      if (currentTime > session.refreshExpiresAt) {
        sessions.delete(sid);
      }
    }
    for (const [key, expiresAt] of revocations) {
      if (currentTime > expiresAt) {
        revocations.delete(key);
      }
    }
  }

  function encodeSegment(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  }

  function decodeToken(token) {
    if (typeof token !== 'string') {
      throw new TokenError('invalid_token');
    }
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => part === '' || !/^[A-Za-z0-9_-]+$/.test(part))) {
      throw new TokenError('invalid_token');
    }

    let header;
    let payload;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new TokenError('invalid_token');
    }

    if (!isObject(header) || header.alg !== 'HS256') {
      throw new TokenError('invalid_token');
    }
    return { parts, header, payload };
  }

  function keyForHeader(header) {
    const key = findKey(currentKeys, header.kid);
    if (key === null) {
      throw new TokenError('unknown_kid');
    }
    if (
      key.state === 'verifyOnly'
      && key.verifyUntilMs !== null
      && now() > key.verifyUntilMs
    ) {
      throw new TokenError('key_expired');
    }
    return key;
  }

  function verifySignature(parts, key) {
    const signingInput = `${parts[0]}.${parts[1]}`;
    const expected = crypto.createHmac('sha256', key.secret).update(signingInput, 'utf8').digest();
    const provided = Buffer.from(parts[2], 'base64url');
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      throw new TokenError('bad_signature');
    }
  }

  function checkTiming(payload) {
    if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) {
      throw new TokenError('invalid_token');
    }
    const currentTime = now();
    if (payload.iat > currentTime + config.clockSkewMs) {
      throw new TokenError('not_yet_valid');
    }
    if (currentTime > payload.exp + config.clockSkewMs) {
      throw new TokenError('expired');
    }
  }

  function checkRevocation(payload) {
    if (revocations.has(tokenKey(payload.jti))) {
      throw new TokenError('revoked');
    }
    const session = sessions.get(payload.sid);
    if (revocations.has(sessionKey(payload.sid)) || session?.revoked === true) {
      throw new TokenError('session_revoked');
    }
  }

  function authenticate(token, expectedTyp) {
    const { parts, header, payload } = decodeToken(token);
    const key = keyForHeader(header);
    verifySignature(parts, key);

    if (!isObject(payload) || payload.iss !== config.issuer) {
      throw new TokenError('wrong_issuer');
    }
    if (payload.typ !== expectedTyp) {
      throw new TokenError('wrong_typ');
    }
    checkTiming(payload);
    checkRevocation(payload);
    return payload;
  }

  function authenticateForRevocation(token) {
    const { parts, header, payload } = decodeToken(token);
    const key = keyForHeader(header);
    verifySignature(parts, key);

    if (!isObject(payload) || payload.iss !== config.issuer) {
      throw new TokenError('wrong_issuer');
    }
    if (!Number.isFinite(payload.exp)) {
      throw new TokenError('invalid_token');
    }
    return payload;
  }

  function mintToken({ sub, sid, typ, iat, ttlMs, jti }) {
    const header = { alg: 'HS256', typ: 'JWT', kid: signingKey(currentKeys).kid };
    const payload = { iss: config.issuer, sub, sid, typ, jti, iat, exp: iat + ttlMs };
    const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
    const signature = crypto
      .createHmac('sha256', signingKey(currentKeys).secret)
      .update(signingInput, 'utf8')
      .digest('base64url');
    return { payload, token: `${signingInput}.${signature}` };
  }

  function issuePair({ sub, sid, iat }) {
    const access = mintToken({
      sub,
      sid,
      typ: 'access',
      iat,
      ttlMs: config.accessTtlMs,
      jti: generateId('jti'),
    });
    const refresh = mintToken({
      sub,
      sid,
      typ: 'refresh',
      iat,
      ttlMs: config.refreshTtlMs,
      jti: generateId('jti'),
    });
    metrics.inc('access_issued_total');
    metrics.inc('refresh_issued_total');
    return { access, refresh };
  }

  return {
    issue({ sub } = {}) {
      cleanup();
      if (typeof sub !== 'string' || sub === '') {
        throw new TokenError('invalid_request');
      }

      const iat = now();
      const sid = generateId('sid');
      const { access, refresh } = issuePair({ sub, sid, iat });
      sessions.set(sid, {
        sub,
        refreshJti: refresh.payload.jti,
        refreshExpiresAt: refresh.payload.exp + config.clockSkewMs,
        revoked: false,
      });

      return {
        accessToken: access.token,
        refreshToken: refresh.token,
        sid,
        accessExpiresAt: access.payload.exp,
        refreshExpiresAt: refresh.payload.exp,
      };
    },
    refresh({ refreshToken } = {}) {
      cleanup();
      const payload = authenticate(refreshToken, 'refresh');
      const session = sessions.get(payload.sid);

      if (!session || session.revoked || revocations.has(sessionKey(payload.sid))) {
        throw new TokenError('session_revoked');
      }
      if (payload.jti !== session.refreshJti) {
        session.revoked = true;
        metrics.inc('refresh_replayed_total');
        metrics.inc('session_revoked_total');
        throw new TokenError('refresh_replayed');
      }

      const { access, refresh } = issuePair({
        sub: session.sub,
        sid: payload.sid,
        iat: now(),
      });
      session.refreshJti = refresh.payload.jti;
      session.refreshExpiresAt = refresh.payload.exp + config.clockSkewMs;
      metrics.inc('refresh_ok_total');

      return {
        accessToken: access.token,
        refreshToken: refresh.token,
        sid: payload.sid,
        accessExpiresAt: access.payload.exp,
        refreshExpiresAt: refresh.payload.exp,
      };
    },
    verify(token, { typ = 'access' } = {}) {
      cleanup();
      try {
        const payload = authenticate(token, typ);
        metrics.inc('verify_ok_total');
        return payload;
      } catch (error) {
        if (error instanceof TokenError) {
          metrics.inc('verify_rejected_total');
        }
        throw error;
      }
    },
    revoke({ token, scope = 'token' } = {}) {
      cleanup();
      if (scope !== 'token' && scope !== 'session') {
        throw new TokenError('invalid_request');
      }

      const payload = authenticateForRevocation(token);
      const currentTime = now();
      if (currentTime > payload.exp + config.clockSkewMs) {
        metrics.inc('revoke_skipped_total');
        return { revoked: false, scope, reason: 'expired' };
      }

      if (scope === 'token') {
        const key = tokenKey(payload.jti);
        if (revocations.has(key)) {
          return { revoked: true, scope };
        }
        if (revocations.size >= config.revocationCapacity) {
          metrics.inc('revocation_rejected_total');
          throw new TokenError('revocation_capacity_exceeded');
        }
        revocations.set(key, payload.exp + config.clockSkewMs);
        metrics.inc('token_revoked_total');
        return { revoked: true, scope };
      }

      const session = sessions.get(payload.sid);
      const key = sessionKey(payload.sid);
      const alreadyRevoked = revocations.has(key) || session?.revoked === true;
      if (!session && !alreadyRevoked) {
        throw new TokenError('session_revoked');
      }
      if (alreadyRevoked) {
        return { revoked: true, scope };
      }
      if (revocations.size >= config.revocationCapacity) {
        metrics.inc('revocation_rejected_total');
        throw new TokenError('revocation_capacity_exceeded');
      }
      revocations.set(key, session.refreshExpiresAt);
      session.revoked = true;
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
