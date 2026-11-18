/**
 * 闲管家「虚拟货源标准接口」的数据契约。
 *
 * 全部来自官方文档（Apifox 项目 5001206）：
 *   https://s.apifox.cn/cf4d53fd-8bb2-41c5-8da3-371ba9a38956/llms.txt
 *
 * ⚠️ 官方反复强调「所有参数都是强校验」——字段名、类型、必填都必须逐字对齐。
 * 特别注意：金额一律用「分」且必须是 **整数**（number 不能是字符串）。
 */

/** 统一响应信封。成功必须 code=0 */
export interface VsResponse<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

/** 失败响应：官方失败 schema 只有 code + msg，**没有 data** */
export interface VsErrorResponse {
  code: number;
  msg: string;
}

/** 官方错误码（《接入说明 › 全局错误码说明》） */
export const VS_ERRORS: Record<number, string> = {
  0: '请求成功',
  1: '请求错误（不在定义范围内的错误）',
  401: '签名错误',
  403: '访问IP不在IP白名单内',
  408: '时间戳已超过有效期',
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
};

/** 商品类型：1 直充 / 2 卡密 / 3 券码。网盘资源走卡密。 */
export const GOODS_TYPE = {
  RECHARGE: 1,
  CARD: 2,
  TICKET: 3,
} as const;

/** 商品状态：1 在架 / 2 下架 */
export const GOODS_STATUS = { ON: 1, OFF: 2 } as const;

/** 订单状态：10 处理中 / 20 已成功 / 30 已失败 */
export const ORDER_STATUS = { PENDING: 10, SUCCESS: 20, FAILED: 30 } as const;

/** 查询平台信息 → data */
export interface PlatformInfo {
  app_id: number;
  features: {
    is_support_order_refund: boolean;
    is_support_goods_notify: boolean;
    is_support_loss_purchase: boolean;
  };
}

/** 查询商户信息 → data */
export interface MerchantInfo {
  /** 商户余额（分）。自研系统固定返回一个 >0 的整数即可 */
  balance: number;
}

/** 商品（列表与详情共用同一结构） */
export interface Goods {
  goods_no: string;
  goods_type: number;
  goods_name: string;
  /** 价格（分） */
  price: number;
  stock: number;
  status: number;
  /** 最后更新时间的秒级时间戳 */
  update_time: number;
  /**
   * 库存模式。这是本网关对官方契约的一处**业务扩展**，官方无此字段。
   *
   * - `pool`（默认）：一单一链。每条卡密只发一次，发完即下架。
   *   适合「每条链接都能单独作废/限流」的场景，但需要预先准备 N 条链接。
   * - `shared`：一链多发。同一份内容重复发给所有买家，库存按 shared_stock 计。
   *   在**没有百度分享 API**的前提下，这是唯一能支撑规模化销售的模式
   *   （否则卖 200 单就要手工建 200 条链接）。
   *   代价：链接可被转卖，只能靠「有效期 + 定期轮换」约束。
   */
  stock_mode?: 'pool' | 'shared';
  /** shared 模式下对外展示的库存上限，默认 9999 */
  shared_stock?: number;
  /** 直充模板，卡密商品无需返回 */
  template?: GoodsTemplateField[];
}

export interface GoodsTemplateField {
  code: string;
  name: string;
  desc?: string;
  check: number;
}

export interface GoodsListData {
  list: Goods[];
  count: number;
}

/** 创建卡密订单 → 请求体 */
export interface PurchaseCreateBody {
  /** 管家订单号 */
  order_no: string;
  goods_no: string;
  buy_quantity: number;
  /** 回调地址。同步返回结果时可不下发通知，但字段本身必传 */
  notify_url: string;
  /** 业务订单号（闲鱼订单号） */
  biz_order_no: string;
  /** 订单总价（分），也是商家可接受的最大成本价 */
  max_amount?: number;
  product_id?: number;
  product_sku?: number;
  item_id?: number;
}

export interface CardItem {
  card_no?: string;
  card_pwd: string;
  card_type?: number;
  start_time?: number;
  end_time?: number;
}

/** 创建卡密订单 / 查询订单详情 → data */
export interface OrderData {
  out_order_no: string;
  order_no: string;
  order_status: number;
  order_amount: number;
  order_time: number;
  end_time?: number;
  goods_no?: string;
  goods_name?: string;
  buy_quantity?: number;
  card_items?: CardItem[];
  remark?: string;
}

/** 查询订单详情 → 请求体 */
export interface OrderDetailBody {
  /** 订单类型，与商品类型同构：1 直充 / 2 卡密 / 3 券码 */
  order_type: number;
  order_no?: string;
  out_order_no?: string;
}

// ------------------------------------------------ 商品变更订阅（自动调价）

/**
 * 订阅商品变更通知 → 请求体（官方 api-205398617）。
 *
 * 闲管家订阅我们侧商品的价格 / 库存 / 状态变更，用于「自动调价」。
 * 回调有两种模式，`token` 与 `notify_url` **都是必填**：
 *   - 固定回调地址：给 `token`，管家把我们的推送打到它自己的固定地址
 *   - 动态回调地址：给 `notify_url`，管家用这个地址收我们的推送
 */
export interface GoodsChangeSubscribeBody {
  /** 1 直充 / 2 卡密（券码不在订阅范围内） */
  goods_type: number;
  goods_no: string;
  token: string;
  notify_url: string;
}

/** 取消商品变更通知 → 请求体（官方 api-205398623） */
export interface GoodsChangeUnsubscribeBody {
  goods_type: number;
  goods_no: string;
  token: string;
}

/** 查询订阅商品列表 → 请求体（官方 api-205403968） */
export interface GoodsChangeSubscribeListBody {
  /** 可选过滤：1 直充 / 2 卡密 / 3 券码 */
  goods_type?: number;
  goods_no?: string;
  page_no: number;
  /** 官方注明「最大行数需支持到 100」 */
  page_size: number;
}

/** 订阅列表里的一条 */
export interface SubscribeItem {
  goods_type: number;
  goods_no: string;
  subscribe_time: number;
  token?: string;
  notify_url?: string;
}

export interface SubscribeListData {
  list: SubscribeItem[];
  count: number;
}

/** 只有 code + msg 的成功响应。订阅类接口的官方 schema **没有 data** */
export interface VsBareResponse {
  code: number;
  msg: string;
}
