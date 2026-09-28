export const hex = (bytes) => [...bytes].map((one) => one.toString(16).padStart(2, '0')).join(' ');

export const fromHex = (text) => Uint8Array.from(
  text.trim().split(/\s+/).map((one) => Number.parseInt(one, 16)),
);

export const bytes = (...values) => Uint8Array.from(values);

export const repeat = (byte, count) => new Uint8Array(count).fill(byte);

// 固定的伪随机流，用来生成"没有规律"的大块数据。
export const noisy = (count, seed = 1) => {
  let state = seed >>> 0;
  const out = new Uint8Array(count);
  for (let at = 0; at < count; at += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[at] = (state >>> 16) & 0xff;
  }
  return out;
};

export const concat = (...parts) => {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
