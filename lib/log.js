// 只当字节用的追加日志：引擎往里 append，想省地方就 truncate / dropPrefix。
// 落盘、刷盘这些不在这层，测试里用这个内存实现就够。
export function createMemoryLog(initial = Buffer.alloc(0)) {
  let data = Buffer.from(initial);
  return {
    append(bytes) {
      const offset = data.length;
      data = Buffer.concat([data, Buffer.from(bytes)]);
      return { offset, length: bytes.length };
    },
    bytes() {
      return Buffer.from(data);
    },
    truncate(length) {
      data = Buffer.from(data.subarray(0, Math.max(0, Math.min(length, data.length))));
      return data.length;
    },
    dropPrefix(length) {
      data = Buffer.from(data.subarray(Math.max(0, Math.min(length, data.length))));
      return data.length;
    },
    get size() {
      return data.length;
    },
  };
}
