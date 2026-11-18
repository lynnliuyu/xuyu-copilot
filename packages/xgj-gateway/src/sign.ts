/**
 * 闲管家「虚拟货源」签名 —— 与开放平台（/api/open/*）的签名**完全不同**。
 *
 * 出处：《闲管家虚拟货源标准接口 › 接入说明 › 签名规则说明》
 *   https://s.apifox.cn/cf4d53fd-8bb2-41c5-8da3-371ba9a38956/doc-4985015.md
 *
 *   sign = md5("app_id,app_secret,md5(body),timestamp,mch_id,mch_secret")
 *
 * 六个参数的含义（这一步极易搞混，务必看清谁是甲方）：
 *   app_id     = 闲管家提供：应用概况里的 AppKey
 *   app_secret = 闲管家提供：应用概况里的 AppSecret
 *   mch_id     = 货源方（我们）提供：任取一个商户号，填进「货源授权信息」
 *   mch_secret = 货源方（我们）提供：任取一个密钥，填进「货源授权信息」
 *   timestamp  = 请求发起时的秒级时间戳，5 分钟内有效
 *   body       = **压缩 JSON**（无任何空白），请求体与签名必须逐字节一致
 *
 * 已用官方测试向量验证（scripts/verify-sign-vs.ts）：
 *   app_id     677859093659717
 *   app_secret wK63PxlOBaY9NoqMksLeZySzGIW25ifA
 *   mch_id     100
 *   mch_secret o9wl81dncmvby3ijpq7eur456zhgtaxs
 *   timestamp  1724414553
 *   body       {"goods_type":1,"goods_no":"12344532"}
 *   → bodyMd5  9b8030f5097d5ed123405b003dd247c5
 *   → sign     f8677927fd8421a75718e8cfaaf92221   ✅ 与官方一致
 */
import crypto from 'node:crypto';

export function md5(s: string): string {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

/**
 * 把 body 归一为「压缩 JSON」。
 *
 * ⚠️ 关键约束：签名用的是 body 的 md5，而验签方拿到的是**原始字节**。
 * 所以两端必须使用同一种序列化方式。官方明确要求「body 一定要使用压缩后的 json」，
 * 对应 JS 的 JSON.stringify（无空格）。任何 pretty-print 都会导致 401。
 */
export function compactBody(body: unknown): string {
  if (body === undefined || body === null) return '{}';
  if (typeof body === 'string') return body === '' ? '{}' : body;
  return JSON.stringify(body);
}

export interface VsSignParams {
  /** 闲管家应用 AppKey */
  appId: string;
  /** 闲管家应用 AppSecret */
  appSecret: string;
  /** 货源方商户ID（我们定义，填在货源授权信息） */
  mchId: string;
  /** 货源方对接密钥（我们定义，填在货源授权信息） */
  mchSecret: string;
  /** 秒级时间戳 */
  timestamp: string | number;
  /** 已压缩的 body 原文；无 body 时传 '{}' 或 '' */
  bodyString: string;
}

/** 计算 sign。参数顺序固定，顺序错一个字符结果就完全不同。 */
export function genVsSign(p: VsSignParams): string {
  const bodyMd5 = md5(p.bodyString);
  return md5([p.appId, p.appSecret, bodyMd5, String(p.timestamp), p.mchId, p.mchSecret].join(','));
}

/**
 * 供调试用：返回完整签名原料，方便在日志/自测里定位 401。
 */
export function explainSign(p: VsSignParams) {
  const bodyMd5 = md5(p.bodyString);
  const signSource = [p.appId, p.appSecret, bodyMd5, String(p.timestamp), p.mchId, p.mchSecret].join(',');
  return { bodyMd5, signSource, sign: md5(signSource) };
}

/** 恒定时间比较，避免时序侧信道（签名是敏感值） */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
