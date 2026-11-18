/**
 * 闲管家开放平台请求/响应类型定义。
 * 字段名与官方 Apifox 文档逐字对齐，不做驼峰转换，便于对照排查。
 */

/* ---------------- 用户 ---------------- */

export interface Shop {
  authorize_id: number;
  authorize_expires: number;
  user_id: number;
  user_name?: string;
  nick?: string;
  shop_name?: string;
}

/* ---------------- 商品：创建 ---------------- */

/** 商品属性键值对（channel_pv） */
export interface ChannelPv {
  property_id: string;
  property_name: string;
  value_id: string;
  value_name: string;
}

/** 发布到某个店铺的设置（publish_shop 数组元素） */
export interface PublishShop {
  /** 闲鱼会员名，指上架到哪个店铺 */
  user_name: string;
  province: number;
  city: number;
  district: number;
  title: string;
  content: string;
  /** 商品图片，必须是公网可访问的 http/https 地址，不支持本地图片 */
  images: string[];
  /** 商品服务标识。不传即默认；传了但店铺未开通对应服务会导致上架失败 */
  service_support?: string;
}

export interface SkuItem {
  price: number;
  stock: number;
  outer_id?: string;
  /** 形如 "颜色:白色;容量:128G" */
  sku_text: string;
}

export interface BookData {
  title?: string;
  author?: string;
  publisher?: string;
  isbn?: string;
}

export interface FoodData {
  pack?: string;
  spec?: string;
  brand?: string;
  expire?: { num: number; unit: string };
  production?: {
    date?: string;
    address?: { detail?: string; province?: number; city?: number; district?: number };
  };
}

/** 创建商品请求体 */
export interface CreateProductReq {
  /** 商品类型，见 ITEM_BIZ_TYPE */
  item_biz_type: number;
  /** 行业类型，见 SP_BIZ_TYPE */
  sp_biz_type: number;
  /** 闲鱼类目 ID（由 productCategoryList 取得） */
  channel_cat_id: string;
  /** 类目属性，必填属性缺失会导致创建失败 */
  channel_pv: ChannelPv[];
  /** 价格，单位：分 */
  price: number;
  /** 原价，单位：分 */
  original_price?: number;
  /** 运费，单位：分 */
  express_fee?: number;
  stock: number;
  /** 商家自有编码（SKU） */
  outer_id?: string;
  /** 商品成色，100 = 全新 */
  stuff_status?: number;
  /** 闲鱼特卖类型 */
  flash_sale_type?: number;
  publish_shop: PublishShop[];
  sku_items?: SkuItem[];
  book_data?: BookData;
  food_data?: FoodData;
  /** 第三方业务流水号，幂等标识 */
  biz_order_id?: string;
}

export interface CreateProductResp {
  product_id: number;
}

/* ---------------- 商品：查询 ---------------- */

export interface ProductListItem {
  product_id: number;
  title?: string;
  price?: number;
  stock?: number;
  /** 商品状态 */
  product_status?: number;
  publish_status?: number;
  outer_id?: string;
  images?: string[];
}

export interface ProductDetail extends ProductListItem {
  item_id?: number;
  channel_cat_id?: string;
  channel_pv?: ChannelPv[];
  publish_shop?: PublishShop[];
  sku_items?: SkuItem[];
  created?: string;
  updated?: string;
}

/* ---------------- 商品：类目 / 属性 ---------------- */

export interface CategoryNode {
  channel_cat_id: string;
  /**
   * ⚠️ 实测（2026-10-07）：接口返回的类目名字段是 `channel_cat_name`，
   * 而 `name` 是空的 —— 早期按 `name` 解析导致类目列表只显示一串 hash。
   * 两个都保留，打印时优先取 channel_cat_name。
   */
  name?: string;
  channel_cat_name?: string;
  sp_biz_type?: number;
  sp_biz_name?: string;
  /** 是否有子类目 */
  leaf?: boolean;
  children?: CategoryNode[];
}

export interface CategoryProperty {
  property_id: string;
  property_name: string;
  required?: boolean;
  value_list?: Array<{ value_id: string; value_name: string }>;
}

/* ---------------- 订单 ---------------- */

export interface OrderListItem {
  order_no: string;
  order_type?: number;
  user_name?: string;
  item_title?: string;
  amount?: number;
  order_status?: number;
  created?: string;
  paid_time?: string;
}

export interface OrderDetail extends OrderListItem {
  buyer_nick?: string;
  receiver_name?: string;
  receiver_phone?: string;
  receiver_address?: string;
  product_id?: number;
  item_id?: number;
  buyer_words?: string;
  refund_status?: number;
}

export interface OrderKami {
  kami_id?: number;
  kind_id?: number;
  kami_text?: string;
  order_no?: string;
  status?: number;
}

/* ---------------- 推送 ---------------- */

export interface PushEnvelope<T = Record<string, unknown>> {
  seller_id?: number;
  [k: string]: unknown;
  /** 内部字段：原始报文 */
  __raw?: T;
}

export interface ProductPushPayload {
  seller_id?: number;
  product_id?: number;
  product_status?: number;
  publish_status?: number;
  user_name?: string;
  item_id?: number;
  /** 失败原因（回调通知里常见） */
  fail_msg?: string;
  [k: string]: unknown;
}

export interface OrderPushPayload {
  seller_id?: number;
  user_name?: string;
  order_no?: string;
  order_type?: number;
  order_status?: number;
  refund_status?: number;
  [k: string]: unknown;
}

/* ---------------- 卡密 ---------------- */

export interface KamiCategory {
  category_id?: number;
  category_name?: string;
}

export interface KamiKind {
  kind_id?: number;
  kind_name?: string;
  kind_alias?: string;
  kind_category?: number;
  kind_type?: number;
  card_type?: number;
  pwd_type?: number;
  card_prefix?: string;
  pwd_prefix?: string;
  /** ⚠️ 类型定义写 string，但接口**实际返回 number（0）**，写回时必须转成数字 */
  separator?: string | number;
  stock_warning?: number;
  sort?: number;
  /** ⚠️ 接口返回字符串 "0.00"，`kind/edit` 却要求 number，写回时必须 Number() */
  cost?: number | string;

  /* ── 以下字段 2026-10-19 实测由 `kami/kind/list|info` 返回，旧文档未收录 ── */
  /** 关联的应用 ID。**必须填真实应用 ID，填 0 时 goods_no 会被服务端静默忽略** */
  app_id?: number;
  /** 应用名，由服务端按 app_id 回填（只读） */
  app_name?: string;
  /** 关联的商品编号 —— 这一步就是后台「关联商品」，可写。⚠️ 服务端**不校验存在性** */
  goods_no?: string;
  /** 关联商品名。实测不会自动同步，需要自己填（可留空） */
  goods_name?: string;
  /** 商品价格（只读，字符串） */
  goods_price?: string;
  /** 商品库存（只读） */
  goods_stock?: number;
  /** 优先销售方式：1 = 卡密库存 */
  priority_sale?: number;
  priority_sale_name?: string;
  kind_category_name?: string;
  separator_name?: string;
  avg_cost?: string;
  total_cost?: string;
  stock?: number;
  sold?: number;
  total_stock?: number;
  modify_time?: string;
  create_time?: string;
}

/** `kami/kind/edit` 可写字段白名单（实测确认，其余字段传了会被忽略） */
export const KAMI_KIND_EDITABLE = [
  'kind_name',
  'kind_alias',
  'kind_category',
  'kind_type',
  'card_type',
  'pwd_type',
  'card_prefix',
  'pwd_prefix',
  'separator',
  'stock_warning',
  'sort',
  'cost',
  'app_id',
  'goods_no',
  'goods_name',
] as const;

export interface KamiGroup {
  group_id?: number;
  group_name?: string;
  kind_group?: Array<{ kind_id: number; num?: number }>;
  status?: number;
}
