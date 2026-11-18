import { BdpanError, isRetryable, sleep } from './errors';

const BASE = 'https://pan.baidu.com';
const OAUTH = 'https://openapi.baidu.com';
// 官方示例统一要求该 UA，缺失时部分接口会返回 errno=-6
const UA = 'pan.baidu.com';

export { BASE as PAN_BASE, OAUTH as OAUTH_BASE };

type Params = Record<string, string | number | undefined>;

function toQuery(params: Params): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    sp.append(k, String(v));
  }
  return sp.toString();
}

function toForm(params: Params): string {
  return toQuery(params);
}

async function handle(res: Response, endpoint: string): Promise<any> {
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`[${endpoint}] 响应不是合法 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`);
  }
  if (res.status !== 200) {
    throw new Error(`[${endpoint}] HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  // OAuth 接口用 error / error_description
  if (json.error) {
    throw new Error(`[${endpoint}] ${json.error}: ${json.error_description ?? ''}`);
  }
  if (json.errno !== undefined && Number(json.errno) !== 0) {
    throw new BdpanError(endpoint, json);
  }
  return json;
}

async function withRetry<T>(fn: () => Promise<T>, endpoint: string, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === retries || !isRetryable(err)) throw err;
      const wait = Math.round(1500 * Math.pow(2, i) * (0.8 + Math.random() * 0.4));
      process.stderr.write(`[retry] ${endpoint} 第 ${i + 1} 次重试，等待 ${wait}ms\n`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

export async function panGet(endpoint: string, params: Params): Promise<any> {
  return withRetry(async () => {
    const url = `${BASE}${endpoint}?${toQuery(params)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    return handle(res, endpoint);
  }, endpoint);
}

/**
 * 写接口通用形态：query 与 body 分开传。
 *
 * 实测结论（2026-10-06）—— 百度 xpan 写接口的参数位置是有讲究的：
 *   create(mkdir)  : query = method, access_token          body = path/isdir/rtype
 *   filemanager    : query = method, access_token, opera, async   body = filelist
 * 位置放错的表现：method 进 body → HTTP 400 Unsupported open api；
 *                 参数全进 query → errno=2 参数错误。
 */
export async function panPostMixed(
  endpoint: string,
  query: Params,
  body: Params,
): Promise<any> {
  return withRetry(async () => {
    const url = `${BASE}${endpoint}?${toQuery(query)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: toForm(body),
    });
    return handle(res, endpoint);
  }, endpoint);
}

/**
 * 百度网盘的写接口有一个反直觉的约定（2026-10-06 实测确认）：
 *
 *   **`method` 必须放在 query string，其余参数放在 form body。**
 *
 * 两者放错位置会得到完全不同的错误：
 *   - method 也放进 body  → HTTP 400 {"error_code":3,"error_msg":"Unsupported open api"}
 *   - 全部参数放 query    → HTTP 200 {"errno":2}  参数错误
 *   - method 在 query + 参数在 body → errno=0 成功 ✅
 *
 * 这里自动把 method 提到 query，调用方无需关心。
 */
export async function panPostForm(endpoint: string, params: Params): Promise<any> {
  const { method, ...rest } = params as Record<string, unknown>;
  const query = method !== undefined ? { method: String(method) } : {};
  return withRetry(async () => {
    const url = `${BASE}${endpoint}${Object.keys(query).length ? `?${toQuery(query)}` : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: toForm(rest as Params),
    });
    return handle(res, endpoint);
  }, endpoint);
}

/** OAuth 换 token / 刷新 token */
export async function oauthToken(params: Params): Promise<any> {
  const endpoint = '/oauth/2.0/token';
  const url = `${OAUTH}${endpoint}?${toQuery(params)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  return handle(res, endpoint);
}
