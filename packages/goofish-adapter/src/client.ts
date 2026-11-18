import { compactBody, genSign, md5 } from './sign';
import { RateLimiter, sleep } from '../../bdpan-core/src/index';

export const GOOFISH_DOMAIN = 'https://open.goofish.pro';

/**
 * 全局错误码（《接入说明》原文）。
 * 注意 401/403/408 这三个是「接入配置类」错误，出现即说明环境没配好，不是业务问题。
 */
export const GOOFISH_ERRORS: Record<number, string> = {
  0: '请求成功',
  1: '请求错误（不在定义范围内的错误）',
  401: '签名错误',
  403: '访问 IP 不在 IP 白名单内',
  408: '时间戳已超过有效期（5 分钟）',
  500: '系统异常，请重试',
  1000: '商户不存在',
  1001: '商户不可用',
  1002: '商户余额不足',
  1100: '商品不存在',
  1101: '商品不可用',
  1102: '商品库存不足',
  1200: '订单不存在',
  1201: '下单参数错误',
  1202: '下单金额低于成本价',
  1203: '下单管家订单号已存在',
  1209: '下单超时，请查单确认下单结果',
  // 通用错误码（实测确认，官方错误码表未收录）
  /**
   * ⚠️ 100001 是**通用兜底错误码**，真实原因只在 `msg` 里，绝不能按码判断。
   * 2026-10-07 实测至少出现过两种完全不同语义：
   *   ① `1788532675364357:应用不存在或已下线` —— 应用未上线
   *   ② `每个商品只能发布1个闲鱼店铺` —— 业务拒绝，与应用状态无关
   * **看到 100001 必须读 msg，否则会把业务错误误判成「应用未上线」。**
   */
  100001: '通用兜底错误码 —— 真实原因见 msg（可能是应用未上线，也可能是业务拒绝）',
};

/**
 * 历史上被当作「应用级错误」处理。实际上 100001 既可能是应用级问题，
 * 也可能是普通业务拒绝，所以这里**只用于提示口径**，不作为分支判据。
 * 判据一律用 `msg` 内容。
 */
export const APP_LEVEL_ERRORS = new Set([100001]);

/** 接入配置类错误 —— 触发这些错误说明账号/网络环境尚未就绪 */
export const SETUP_ERRORS = new Set([401, 403, 408]);

export interface GoofishResponse<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

export class GoofishError extends Error {
  readonly code: number;
  readonly raw: unknown;
  readonly path: string;
  constructor(path: string, resp: { code?: number; msg?: string }) {
    const code = Number(resp?.code ?? -1);
    const hint = GOOFISH_ERRORS[code];
    super(`[${path}] code=${code} ${resp?.msg ?? ''}${hint && code !== 0 ? ` — ${hint}` : ''}`);
    this.name = 'GoofishError';
    this.code = code;
    this.raw = resp;
    this.path = path;
  }
}

export interface GoofishConfig {
  appKey: string;
  appSecret: string;
  /** 商务对接模式才需要；自研/第三方 ERP 对接留空 */
  sellerId?: string;
  domain?: string;
  /** 每秒请求数，官方默认 10 */
  qps?: number;
  /** 失败重试次数 */
  retries?: number;
}

/** 可重试的错误码：系统异常 / 未定义错误 */
const RETRYABLE = new Set([500, 1]);

export interface BuiltRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  /** 便于排查：签名中间值 */
  debug: { bodyMd5: string; timestamp: number; signSource: string };
}

export class GoofishClient {
  private readonly limiter: RateLimiter;
  readonly domain: string;
  readonly configured: boolean;

  constructor(private readonly cfg: GoofishConfig) {
    this.domain = cfg.domain ?? GOOFISH_DOMAIN;
    // 官方限制：单账号所有接口合计 QPS = 10
    this.limiter = new RateLimiter(Math.ceil(1000 / (cfg.qps ?? 10)));
    this.configured = Boolean(cfg.appKey && cfg.appSecret);
  }

  /**
   * 组装一个完整请求（不发出去），用于 dry-run 预览与排查。
   *
   * 拼装规则（逐字对齐官方代码示例）：
   *   url = {domain}{path}?appid={appKey}&timestamp={ts}&sign={sign}
   *   商务对接模式额外带 &seller_id={sellerId}
   *   body 必须是**压缩 JSON**（无空格），且 body 里不出现 appid/timestamp/sign
   */
  buildRequest(path: string, body: Record<string, unknown> = {}): BuiltRequest {
    const timestamp = Math.floor(Date.now() / 1000);
    const bodyString = compactBody(body);
    const bodyMd5 = md5(bodyString);
    const sign = this.configured
      ? genSign({
          appKey: this.cfg.appKey,
          appSecret: this.cfg.appSecret,
          timestamp,
          bodyString,
          sellerId: this.cfg.sellerId,
        })
      : '<未配置 appKey/appSecret，无法生成签名>';

    const qs = new URLSearchParams();
    qs.set('appid', this.cfg.appKey || '<appKey>');
    qs.set('timestamp', String(timestamp));
    if (this.cfg.sellerId) qs.set('seller_id', this.cfg.sellerId);
    qs.set('sign', sign);

    const signSource =
      this.cfg.sellerId && this.cfg.sellerId !== ''
        ? `${this.cfg.appKey || '<appKey>'},${bodyMd5},${timestamp},${this.cfg.sellerId},<appSecret>`
        : `${this.cfg.appKey || '<appKey>'},${bodyMd5},${timestamp},<appSecret>`;

    return {
      url: `${this.domain}${path}?${qs.toString()}`,
      method: 'POST',
      // 官方示例为 application/json; charset=utf-8（PHP/JS 示例均带 charset）
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: bodyString,
      debug: { bodyMd5, timestamp, signSource },
    };
  }

  async call<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<GoofishResponse<T>> {
    if (!this.configured) {
      throw new Error(
        '闲管家凭证未配置。请在 .env 中设置 GOOFISH_APP_KEY 与 GOOFISH_APP_SECRET。\n' +
          '获取路径：闲管家 → 开放平台 → 订购 ERP 专业版/铂金版 → 创建「进销存」类型应用 → 应用上线。',
      );
    }
    const retries = this.cfg.retries ?? 2;
    let lastErr: unknown;

    for (let i = 0; i <= retries; i++) {
      try {
        return await this.limiter.run(async () => {
          const req = this.buildRequest(path, body);
          const res = await fetch(req.url, {
            method: req.method,
            headers: req.headers,
            body: req.body,
          });
          const text = await res.text();
          let json: GoofishResponse<T>;
          try {
            json = JSON.parse(text);
          } catch {
            throw new Error(
              `[${path}] 响应非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}\n` +
                `  ⚠️ 若为 404/HTML，多半是应用未上线或路径写错。`,
            );
          }
          if (Number(json.code) !== 0) throw new GoofishError(path, json);
          return json;
        });
      } catch (err) {
        lastErr = err;
        const code = err instanceof GoofishError ? err.code : -1;
        if (i === retries || !RETRYABLE.has(code)) throw err;
        await sleep(1000 * (i + 1));
      }
    }
    throw lastErr;
  }
}
