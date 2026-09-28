// 定种子的伪随机：同一个种子跑出来的 jti / sid 一样，用例才好复现。
export function createSeededRandom(seed = 1) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
