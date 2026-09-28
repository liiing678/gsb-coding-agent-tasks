import { decodeSeries, encodeSeries } from '../lib/tscodec.js';

export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

export const hex = (bytes) => Buffer.from(bytes).toString('hex');

// 一条规规矩矩的序列：步长固定、值每次 +0.5。
export const series = (n, { start = 0, step = 1000 } = {}) => Array.from(
  { length: n },
  (_, i) => ({ t: start + i * step, v: i + 0.5 }),
);

export const roundTrip = (points, options) => decodeSeries(encodeSeries(points, options)).points;
