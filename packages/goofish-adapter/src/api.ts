import { EP } from './endpoints';
import { getClient, appIdFromEnv } from './config';
import type {
  Shop,
  CreateProductReq,
  CreateProductResp,
  ProductListItem,
  ProductDetail,
  CategoryNode,
  CategoryProperty,
  OrderListItem,
  OrderDetail,
  OrderKami,
  KamiCategory,
  KamiKind,
  KamiGroup,
} from './types';

/**
 * 官方返回体统一形如 { code, msg, data }。
 * 这里把 data 直接摊平返回，调用方不用每次都 .data。
 */
async function call<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await getClient().call<unknown>(path, body);
  return (res.data ?? {}) as T;
}

/* ======================== 用户 ======================== */

/** 查询闲鱼店铺。无请求参数，是最轻量的连通性探针。 */
export const listShops = () =>
  call<{ list: Shop[] }>(EP.shopList).then((d) => d.list ?? []);

/** 查询商家地址（部分类目创建商品需要省市区） */
export const listAddresses = () => call<{ list: any[] }>(EP.addressList).then((d) => d.list ?? []);

/* ======================== 商品 ======================== */

/** 查询商品类目。item_biz_type 必填 */
export const listCategories = (params: {
  item_biz_type: number;
  sp_biz_type?: number;
  flash_sale_type?: number;
}) => call<{ list: CategoryNode[] }>(EP.productCategoryList, params).then((d) => d.list ?? []);

/** 查询商品属性（类目下的属性与可选值） */
export const listProperties = (params: {
  item_biz_type: number;
  sp_biz_type?: number;
  channel_cat_id?: string;
}) => call<{ list: CategoryProperty[] }>(EP.productPvList, params).then((d) => d.list ?? []);

export const listProducts = (params: {
  page_no?: number;
  page_size?: number;
  product_status?: number;
  outer_id?: string;
} = {}) => call<{ list: ProductListItem[]; total?: number }>(EP.productList, params);

export const getProduct = (product_id: number) =>
  call<ProductDetail>(EP.productDetail, { product_id });

export const getProductSkus = (product_id: number) =>
  call<{ sku_items: any[] }>(EP.productSkuList, { product_id });

/** 创建商品（单个） */
export const createProduct = (req: CreateProductReq) =>
  call<CreateProductResp>(EP.productCreate, req as unknown as Record<string, unknown>);

/** 创建商品（批量）。body 为 { product_list: [...] } 形式，字段与单个一致 */
export const batchCreateProducts = (product_list: CreateProductReq[]) =>
  call<{ list: Array<{ errno: number; product_id?: number; msg?: string }> }>(EP.productBatchCreate, {
    product_list,
  });

/**
 * 上架商品。
 *
 * ⚠️ 官方特别提醒：上架存在发布失败的可能（如店铺未开通某服务、类目限制），
 * 所以**必须传 notify_url** 接收异步结果，否则失败原因只能去闲管家后台翻列表。
 */
export const publishProduct = (params: {
  product_id: number;
  user_name: string[];
  specify_publish_time?: string;
  notify_url?: string;
}) => call<Record<string, unknown>>(EP.productPublish, params);

export const downShelfProduct = (params: { product_id: number; user_name?: string[] }) =>
  call<Record<string, unknown>>(EP.productDownShelf, params);

export const editProduct = (params: { product_id: number } & Partial<CreateProductReq>) =>
  call<Record<string, unknown>>(EP.productEdit, params as unknown as Record<string, unknown>);

/** 编辑库存（单规格商品可直接改 stock） */
export const editStock = (params: { product_id: number; stock?: number; sku_items?: any[] }) =>
  call<Record<string, unknown>>(EP.productEditStock, params);

export const deleteProduct = (product_id: number) =>
  call<Record<string, unknown>>(EP.productDelete, { product_id });

/* ======================== 订单 ======================== */

export const listOrders = (params: { page_no?: number; page_size?: number; order_status?: number } = {}) =>
  call<{ list: OrderListItem[]; total?: number }>(EP.orderList, params);

export const getOrder = (order_no: string) => call<OrderDetail>(EP.orderDetail, { order_no });

/** 订单卡密列表 —— 虚拟商品自动发货的核心查询 */
export const getOrderKamiList = (order_no: string) =>
  call<{ list: OrderKami[] }>(EP.orderKamiList, { order_no }).then((d) => d.list ?? []);

/**
 * 无需物流发货（虚拟商品用这个）。
 * send_way: 1 = 虚拟发货，2 = 无需物流
 */
export const dummySend = (params: { order_no: string; send_way?: 1 | 2 }) =>
  call<Record<string, unknown>>(EP.orderDummySend, { send_way: 2, ...params });

/** 订单物流发货（实物，需要快递公司编码与单号） */
export const shipOrder = (params: {
  order_no: string;
  express_code?: string;
  waybill_no?: string;
  [k: string]: unknown;
}) => call<Record<string, unknown>>(EP.orderShip, params);

export const modifyPrice = (params: { order_no: string; price: number }) =>
  call<Record<string, unknown>>(EP.orderModifyPrice, params);

export const listExpressCompanies = () =>
  call<{ list: any[] }>(EP.expressCompanies).then((d) => d.list ?? []);

/* ======================== 售后 ======================== */

export const listRefunds = (params: { page_no?: number; page_size?: number } = {}) =>
  call<{ list: any[]; total?: number }>(EP.refundList, params);

export const getRefund = (params: { refund_id?: number; order_no?: string }) =>
  call<Record<string, unknown>>(EP.refundDetail, params);

export const agreeRefund = (params: Record<string, unknown>) =>
  call<Record<string, unknown>>(EP.refundAgree, params);

export const refuseRefund = (params: Record<string, unknown>) =>
  call<Record<string, unknown>>(EP.refundRefuse, params);

/* ======================== 卡密 ======================== */

export const createKamiCategory = (params: { category_name: string }) =>
  call<{ category_id: number }>(EP.kamiCategoryCreate, params);

export const listKamiCategories = () =>
  call<{ list: KamiCategory[] }>(EP.kamiCategoryList).then((d) => d.list ?? []);

export const createKamiKind = (params: KamiKind) =>
  call<{ kind_id: number }>(EP.kamiKindCreate, params as unknown as Record<string, unknown>);

export const listKamiKinds = () =>
  call<{ list: KamiKind[] }>(EP.kamiKindList).then((d) => d.list ?? []);

export const getKamiKind = (kind_id: number) => call<KamiKind>(EP.kamiKindInfo, { kind_id });

/** 编辑卡种（官方 kami/kind/edit）。回滚/改名用得上 */
export const editKamiKind = (params: KamiKind & { kind_id: number }) =>
  call<Record<string, unknown>>(EP.kamiKindEdit, params as unknown as Record<string, unknown>);

/**
 * 把卡种「关联」到一个商品 —— 这就是后台「卡密仓库 → 发货 → 关联商品」的 API 版本。
 *
 * 2026-10-19 用隔离测试卡种实测（建 → 改 → 读回 → 删）：
 *   · `goods_no` 是 **string**、`app_id` 是 **number**，两者都在 `kami/kind/edit` 的 schema 里
 *   · **`app_id` 填 0 时，`goods_no` 会被服务端静默丢弃**（读回是空）—— 这是最容易踩的坑
 *   · 填真实 AppKey 后 `goods_no` 能写入，且 `app_name` 由服务端自动回填
 *   · 服务端**完全不校验商品是否存在**：填 `FAKE-NO-999` 也照样存进去
 *     ⇒ 编号必须自己保证正确，否则就是"看起来绑好了、实际永远不发"
 *
 * ⚠️ `kami/kind/edit` 是**整条覆盖**语义，所以这里先读现状再回写，
 *    并且把 `cost`（列表返回是字符串 "0.00"）转成 number —— 否则报
 *    `type mismatch for field "cost"`。
 */
export async function bindKamiKindToGoods(params: {
  kind_id: number;
  /** 商品编号（我们这里就是台账 code / outer_id，如 BD-GFX-124840） */
  goods_no: string;
  goods_name?: string;
  /** 真实应用 AppKey；不传则读 .env */
  app_id?: number;
}): Promise<{ kind_id: number; app_id: number; goods_no: string }> {
  const appId = params.app_id ?? appIdFromEnv();
  if (!appId) throw new Error('app_id 缺失：.env 里没有 GOOFISH_ERP_APP_KEY / GOOFISH_APP_KEY');

  const k = (await getKamiKind(params.kind_id)) as KamiKind;
  await editKamiKind({
    kind_id: params.kind_id,
    kind_name: k.kind_name ?? '',
    kind_alias: k.kind_alias ?? '',
    kind_category: Number(k.kind_category ?? 0),
    kind_type: Number(k.kind_type ?? 1),
    card_type: Number(k.card_type ?? 1),
    pwd_type: Number(k.pwd_type ?? 1),
    card_prefix: k.card_prefix ?? '',
    pwd_prefix: k.pwd_prefix ?? '',
    separator: Number(k.separator ?? 0),
    stock_warning: Number(k.stock_warning ?? 20),
    sort: Number(k.sort ?? 1),
    cost: Number(k.cost ?? 0),
    app_id: appId,
    goods_no: params.goods_no,
    goods_name: params.goods_name ?? k.goods_name ?? '',
  });

  // 读回核对 —— 服务端不报错不代表写进去了（app_id=0 时就是静默丢弃）
  const after = (await getKamiKind(params.kind_id)) as KamiKind;
  if (String(after.goods_no ?? '') !== params.goods_no) {
    throw new Error(
      `绑定未生效：期望 goods_no=${params.goods_no}，实际=${JSON.stringify(after.goods_no)}（检查 app_id）`,
    );
  }
  return { kind_id: params.kind_id, app_id: appId, goods_no: params.goods_no };
}

/** 解除卡种与商品的关联 */
export async function unbindKamiKind(kind_id: number): Promise<void> {
  const k = (await getKamiKind(kind_id)) as KamiKind;
  await editKamiKind({
    kind_id,
    kind_name: k.kind_name ?? '',
    kind_alias: k.kind_alias ?? '',
    kind_category: Number(k.kind_category ?? 0),
    kind_type: Number(k.kind_type ?? 1),
    card_type: Number(k.card_type ?? 1),
    pwd_type: Number(k.pwd_type ?? 1),
    card_prefix: k.card_prefix ?? '',
    pwd_prefix: k.pwd_prefix ?? '',
    separator: Number(k.separator ?? 0),
    stock_warning: Number(k.stock_warning ?? 20),
    sort: Number(k.sort ?? 1),
    cost: Number(k.cost ?? 0),
    app_id: 0,
    goods_no: '',
    goods_name: '',
  });
}

/**
 * 删除卡种（官方 kami/kind/delete）。⚠️ 不可逆，会连带移除其卡密库存。
 *
 * ⚠️ 实测（2026-10-15）：`kind_id` 必须是**字符串数组** `["1800..."]`。
 *   · 传数字      → `cannot unmarshal number into Go value of type []interface {}`
 *   · 传字符串    → 同上（服务端先按数字解析，再按数组反序列化）
 *   · 传字符串数组 → `{"code":0,"msg":"OK"}` ✅
 */
export const deleteKamiKind = (params: { kind_id: number | string }) =>
  call<Record<string, unknown>>(EP.kamiKindDelete, { kind_id: [String(params.kind_id)] });

/**
 * 卡种添加卡密库存 —— 把「分享链接+提取码」灌进卡密池。
 *
 * 幂等性由 is_repeat 控制（true = 允许重复卡密）。
 */
export const addKamiStock = (params: {
  kind_id: number;
  cards: string[];
  is_repeat?: boolean;
  is_cover?: boolean;
  is_priority?: boolean;
  cost?: number;
}) => call<Record<string, unknown>>(EP.kamiStorageCreate, params);

export const createKamiGroup = (params: { group_name: string; kind_group: Array<{ kind_id: number; num?: number }> }) =>
  call<{ group_id: number }>(EP.kamiGroupCreate, params);
export const listKamiGroups = () =>
  call<{ list: KamiGroup[] }>(EP.kamiGroupList).then((d) => d.list ?? []);

export const updateKamiGroupStatus = (params: { group_id: number; status: number }) =>
  call<Record<string, unknown>>(EP.kamiGroupUpdateStatus, params);
