import crypto from 'node:crypto';

export const md5 = (s: string): string => crypto.createHash('md5').update(s, 'utf8').digest('hex');

/**
 * 生成 body 字符串。
 *
 * ⚠️ 两条硬性要求（来自官方代码示例与接入教程）：
 *  1. 必须是**压缩后的 JSON**（无空格）——官方原话："body一定要使用压缩后的json"
 *     JS 的 JSON.stringify 天然不加空格，可直接用。
 *  2. **参数不排序**，传参 body 是什么样就原样参与签名；中文与链接也原样传，不做 URL 编码。
 */
export function compactBody(body: Record<string, unknown> | undefined | null): string {
  if (!body || Object.keys(body).length === 0) return '{}';
  return JSON.stringify(body);
}

/**
 * 签名：sign = md5("应用KEY,Body报文Md5值,时间戳,应用密钥")
 * 商务对接模式额外插入 sellerId："应用KEY,BodyMd5,时间戳,商家ID,应用密钥"
 *
 * 官方测试向量（《接入说明》）：
 *   appKey    = 203413189371893
 *   appSecret = o9wl81dncmvby3ijpq7eur456zhgtaxs
 *   timestamp = 1636087298
 *   body      = {"product_id":"219530767978565"}
 *   → bodyMd5 = 2608f2139cca8755cabf25209251e549
 *   → sign    = c26c8a48809141f3dd80bd9b9ddb41ea
 */
export function genSign(params: {
  appKey: string;
  appSecret: string;
  timestamp: number;
  bodyString: string;
  sellerId?: string | number;
}): string {
  const bodyMd5 = md5(params.bodyString);
  const parts =
    params.sellerId !== undefined && params.sellerId !== ''
      ? [params.appKey, bodyMd5, String(params.timestamp), String(params.sellerId), params.appSecret]
      : [params.appKey, bodyMd5, String(params.timestamp), params.appSecret];
  return md5(parts.join(','));
}

/** 推送回调验签：验签规则同请求签名但不含 seller_id */
export function verifyPushSign(params: {
  appKey: string;
  appSecret: string;
  timestamp: number | string;
  bodyString: string;
  sign: string;
}): boolean {
  const expect = genSign({
    appKey: params.appKey,
    appSecret: params.appSecret,
    timestamp: Number(params.timestamp),
    bodyString: params.bodyString,
  });
  return expect === params.sign;
}
