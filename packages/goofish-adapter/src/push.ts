import { verifyPushSign } from './sign';
import { GOOFISH_APP_KEY, GOOFISH_APP_SECRET } from './config';
import type { ProductPushPayload, OrderPushPayload } from './types';

/**
 * 接收闲管家推送的 HTTP 请求（Node 原生 IncomingMessage / 通用 shape）。
 *
 * 官方规则（《应用接入教程》FAQ 第 15 条）：
 *   签名值 = md5("应用KEY,Body报文Md5值,时间戳,应用密钥")
 *   —— 推送的**请求参数没有 seller_id**，比主动请求少一段。
 *
 * 响应要求：必须返回 {"result":"success"}，否则闲管家最多重试 3 次。
 * 注意：接口超时 3 秒，官方建议**先返回 success 再异步处理业务**。
 */
export interface PushRequestShape {
  query: Record<string, string | undefined>;
  /** 原始 body 文本（验签必须用原文，不能先 parse 再 stringify） */
  rawBody: string;
}

export interface PushParseResult<T> {
  ok: boolean;
  reason?: string;
  timestamp?: number;
  payload?: T;
}

export function verifyAndParsePush<T = Record<string, unknown>>(
  req: PushRequestShape,
): PushParseResult<T> {
  const { appid, timestamp, sign } = req.query;
  if (!sign) return { ok: false, reason: '缺少 sign' };
  if (!timestamp) return { ok: false, reason: '缺少 timestamp' };

  const expectAppKey = GOOFISH_APP_KEY();
  if (appid && expectAppKey && appid !== expectAppKey) {
    return { ok: false, reason: `appid 不匹配（收到 ${appid}）` };
  }

  // 时间戳容差：官方 5 分钟，这里放宽到 10 分钟以适应时钟漂移
  const ts = Number(timestamp);
  const drift = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (!Number.isFinite(ts) || drift > 600) {
    return { ok: false, reason: `时间戳超出容差（偏移 ${drift}s）` };
  }

  const ok = verifyPushSign({
    appKey: expectAppKey,
    appSecret: GOOFISH_APP_SECRET(),
    timestamp,
    bodyString: req.rawBody,
    sign,
  });
  if (!ok) return { ok: false, reason: '签名不匹配' };

  let payload: T;
  try {
    payload = JSON.parse(req.rawBody || '{}') as T;
  } catch {
    return { ok: false, reason: 'body 不是合法 JSON' };
  }
  return { ok: true, timestamp: ts, payload };
}

/** 官方要求的成功响应体 */
export const PUSH_OK_BODY = JSON.stringify({ result: 'success' });

/* ========================================================================
 * 业务语义层：把推送报文翻译成「该做什么」
 * ====================================================================== */

/** 订单推送的「需要发货」判定 */
export interface OrderAction {
  shouldShip: boolean;
  shouldRefund: boolean;
  shouldAlert: boolean;
  reason: string;
}

export function decideOrderAction(p: OrderPushPayload): OrderAction {
  // order_type: 7 = 卡密订单，8 = 直充订单 → 虚拟商品
  const virtual = p.order_type === 7 || p.order_type === 8;
  const status = Number(p.order_status ?? -1);
  const refund = Number(p.refund_status ?? 0);

  if (refund > 0) {
    return {
      shouldShip: false,
      shouldRefund: true,
      shouldAlert: false,
      // 用户口径（2026-10-20）：退了就直接退，不纠结；分享链接照旧有效，不作废。
      reason: `退款状态变更（refund_status=${refund}）→ 同意退款，保留分享链接`,
    };
  }
  // ⚠️ 状态码以实测为准（REFERENCE 状态码表，2026-10-20 用 consign_time 校正）：
  //   12 = 待发货（consign_time=0）；21 = 已发货待收货；22 完成；23 退款；24 已关闭。
  //   早期这里写的是 2/3「常见取值」，真实推送过来会把待发货判成无需动作。
  if (status === 12) {
    return {
      shouldShip: true,
      shouldRefund: false,
      shouldAlert: false,
      reason: `订单状态=12，待发货${virtual ? '（虚拟商品）' : ''}`,
    };
  }
  return {
    shouldShip: false,
    shouldRefund: false,
    shouldAlert: false,
    reason: `订单状态=${status}，无需动作`,
  };
}

/** 商品推送的「上架是否失败」判定 */
export function decideProductAction(p: ProductPushPayload): {
  failed: boolean;
  reason: string;
} {
  const publishStatus = Number(p.publish_status ?? -1);
  // 常见失败：发布失败状态 + fail_msg
  if (p.fail_msg) {
    return { failed: true, reason: `${p.fail_msg}` };
  }
  if (publishStatus === 3) {
    return { failed: true, reason: '发布失败（publish_status=3），去闲管家后台看「失败原因」列' };
  }
  return { failed: false, reason: `publish_status=${publishStatus}` };
}
