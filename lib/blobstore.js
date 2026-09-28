// 只管字节的键值仓库：key 是内容的 sha256，值是这一份内容的字节。
// 去重、引用计数、配额这些都在 relay 里算，这里不做判断。
export function createMemoryBlobStore() {
  const map = new Map();
  return {
    has: (key) => map.has(key),
    get(key) {
      return map.has(key) ? Buffer.from(map.get(key)) : null;
    },
    put(key, bytes) {
      map.set(key, Buffer.from(bytes));
    },
    delete: (key) => map.delete(key),
    keys: () => [...map.keys()],
    get totalBytes() {
      let n = 0;
      for (const buf of map.values()) n += buf.length;
      return n;
    },
  };
}
