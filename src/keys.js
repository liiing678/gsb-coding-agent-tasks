// 密钥集合的解析与选取。轮换口径见 README 的「密钥轮换」。
//
// state: 'active' 表示这把在签也用它验；'verifyOnly' 表示只验不签，
// 而且过了 verifyUntil 就不认了（过渡期）。verifyUntil 为 null 表示不过期。

export function normalizeKeys(raw) {
  if (!Array.isArray(raw)) {
    throw new Error('keys 必须是数组');
  }
  const seen = new Set();
  const keys = raw.map((entry) => {
    const kid = entry?.kid;
    const secret = entry?.secret;
    const state = entry?.state ?? 'active';
    const verifyUntil = entry?.verifyUntil ?? null;

    if (typeof kid !== 'string' || kid === '') {
      throw new Error('key.kid 必须是非空字符串');
    }
    if (typeof secret !== 'string' || secret.length < 8) {
      throw new Error(`key.secret 必须是不短于 8 个字符的字符串: ${kid}`);
    }
    if (state !== 'active' && state !== 'verifyOnly') {
      throw new Error(`key.state 只能是 active 或 verifyOnly: ${kid}`);
    }
    if (seen.has(kid)) {
      throw new Error(`key.kid 重复: ${kid}`);
    }
    seen.add(kid);

    let verifyUntilMs = null;
    if (verifyUntil !== null) {
      verifyUntilMs = Date.parse(verifyUntil);
      if (Number.isNaN(verifyUntilMs)) {
        throw new Error(`key.verifyUntil 不是合法时间: ${kid} ${verifyUntil}`);
      }
    }
    return { kid, secret, state, verifyUntilMs };
  });

  if (keys.length === 0) {
    throw new Error('至少要有一把密钥');
  }
  return keys;
}

// 签发用的那把：有且只能有一把 state=active。
export function signingKey(keys) {
  const active = keys.filter((key) => key.state === 'active');
  if (active.length !== 1) {
    throw new Error(`有且只能有一把 active 密钥，现在是 ${active.length} 把`);
  }
  return active[0];
}

export function findKey(keys, kid) {
  return keys.find((key) => key.kid === kid) ?? null;
}
