// 响应录制器：handler 不直接碰 res，只往这里写。
// 这样一次执行的结果才能被完整记下来，后面回放给别的请求。
export function createRecorder() {
  const chunks = [];
  const headers = new Map();
  let status = null;
  let ended = false;

  return {
    status(code) {
      if (status !== null) {
        throw new Error('status 已经设过了');
      }
      status = Number(code);
      return this;
    },
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
      return this;
    },
    write(chunk) {
      if (ended) {
        throw new Error('response 已经结束了');
      }
      chunks.push(Buffer.from(chunk));
      return this;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.from(chunk));
      }
      ended = true;
      return this;
    },
    // 一次执行的结果：状态码、响应头、body、有没有正常结束
    captured() {
      return {
        status: status ?? 200,
        headers: [...headers.entries()],
        body: Buffer.concat(chunks),
        ended,
      };
    },
  };
}
