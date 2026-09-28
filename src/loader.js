// 我们平时用的回源实现：打 origin 的 HTTP。测试会换成自己的假 loader。
export function createOriginLoader({ baseUrl, fetchImpl = fetch }) {
  return async function load(key) {
    const url = `${baseUrl}/value?key=${encodeURIComponent(key)}`;
    const response = await fetchImpl(url);
    if (response.status === 404) {
      return { found: false };
    }
    if (!response.ok) {
      throw new Error(`origin 回了 ${response.status}`);
    }
    const body = await response.json();
    return { found: true, value: body.value, tags: body.tags ?? [], ttlMs: body.ttlMs };
  };
}
