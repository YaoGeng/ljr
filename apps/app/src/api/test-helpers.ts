/**
 * API 层测试共用件（M3-W1 T3）：fetch 桩回放 + JSON Response 构造（client.test.ts 局部
 * 形态抽出共用——五份拷贝换一份单源；仅 *.test.ts 消费，不进任何运行时路径）。
 */

/** fetch 桩：按调用序回放预设响应；记录请求供断言 */
export function stubFetch(
  plays: Array<Response | Error>,
): Array<{ url: string; init: RequestInit }> {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? ({} as RequestInit) });
    const next = plays[i++];
    if (i > plays.length) throw new Error('意外的额外请求');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return seen;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
