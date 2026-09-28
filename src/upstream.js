// 真正把请求发出去的那一层：已经实现好了，别改。
//
// 约定（guard 就按这个来用它）：
//   上游回了响应（不管 2xx / 4xx / 5xx）-> 返回 { status, headers, body }
//   连不上                                  -> 抛 EgressError(kind = 'connect')
//   超过 timeoutMs                          -> 抛 EgressError(kind = 'timeout')

import { EgressError, ErrorKind } from './errors.js';

export async function send(request, { timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.method ?? 'GET',
      headers: request.headers ?? {},
      body: request.body,
      redirect: 'manual',
      signal: controller.signal,
    });
    const body = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: Object.fromEntries(response.headers), body };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new EgressError(ErrorKind.TIMEOUT, `上游 ${request.upstream} 超过 ${timeoutMs}ms 没回`, {
        upstream: request.upstream,
      });
    }
    throw new EgressError(
      ErrorKind.CONNECT,
      `连不上上游 ${request.upstream}: ${error?.message ?? error}`,
      { upstream: request.upstream, cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}
