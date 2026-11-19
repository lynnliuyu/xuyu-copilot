/**
 * 自动发货排查（只读聚合 + 本地预检）。
 *
 * 用途：把「两个闲鱼账号自动发货差异」排查需要的证据聚合成一个只读快照，
 * 由管理端 /api/delivery/state 输出，前端「发货排查」页展示；另有只读的
 * 本地预检 /api/delivery/preflight（不调用任何写接口）。
 *
 * 数据来源（全部只读 / 本地授权数据）：
 *   · 网关数据 catalog / cards / orders —— xgj-gateway/src/store.ts
 *   · 上架草稿与台账（商品 → 店铺归属、product_id）—— publish-draft.ts
 *   · 会话记忆 / 批次报告里已核实的「商品侧发货设置」结论 —— 由调用方注入
 *     （consign_active / template_id），本模块不主动联网查。
 * 本模块**没有任何写入口**；配置变更 / 发货走别处的受控流程。
 *
 * 店铺口径：开放平台 user_name（xy346883759115 / 顺和服饰平价超市）是唯一稳定键；
 * 后台 shop_name（繁梦blender精选 / 繁梦空间智能玩家L宇）只作展示。
 */
import {
  loadCatalog,
  cardPool,
  loadOrders,
  goodsWithStock,
} from '../../xgj-gateway/src/store';
import { loadDrafts, loadListings } from './publish-draft';
import type { Goods } from '../../xgj-gateway/src/types';

/** 调用方可注入的「已核实发货设置」（来自 consign apply 报告等授权只读产物） */
export interface ConsignFacts {
  /** product_id → { active: boolean; kind_way?: number; template_id?: number; at?: string } */
  byProduct: Record<string, { active: boolean; kind_way?: number; template_id?: number; at?: string }>;
}

export interface DeliveryGoodsRow {
  goods_no: string;
  goods_name: string;
  /** 归属店铺（user_name）；未知为 null */
  shop: string | null;
  /** 商品侧发货设置是否已启用（有授权只读结论才为 true，否则按缺数据标记） */
  consign_active: boolean | null;
  consign_note?: string;
  template_id: number | null;
  price_fen: number;
  stock_mode: 'pool' | 'shared';
  on_shelf: boolean;
  cards_total: number;
  cards_used: number;
  cards_free: number;
  placeholder: boolean;
  product_id: number | null;
  last_order_no: string | null;
  last_order_at: string | null;
  last_order_status: number | null;
  /** 最近订单是否已产出卡密（需要 order/kam 外网查询；未接通时 null） */
  last_order_kami: number | null;
  updated_at: string;
}

export interface DeliveryPreflightIssue {
  level: 'ok' | 'warn' | 'blocker' | 'info';
  field: string;
  message: string;
}

export interface DeliverySnapshot {
  meta: {
    generatedAt: string;
    dataDir: string;
    /** true = 网关本地有真实台账数据；false = 空目录（演示/未部署） */
    realData: boolean;
    /** true = 已注入已核实的 consign 设置结论 */
    consignFactsInjected: boolean;
  };
  shops: Array<{ user_name: string; label: string; note?: string }>;
  byShop: Record<string, { total: number; consignActive: number; consignUnknown: number; recentOrders: number }>;
  goods: DeliveryGoodsRow[];
  recentOrders: Array<{
    order_no: string; goods_no: string; goods_name?: string; status: number;
    amount_fen: number; at: string; shop: string | null;
  }>;
  candidates: Array<{ goods_no: string; shop: string | null; reason: string }>;
  errors: Array<{ source: string; message: string }>;
}

const isPlaceholder = (t: string) => /xxxxxxxx|占位|请替换/i.test(t || '');

function goodsShopIndex(): Map<string, string> {
  const m = new Map<string, string>();
  for (const { code, draft } of loadDrafts()) {
    const un = draft?.publish_shop?.[0]?.user_name;
    if (un) m.set(code, String(un));
  }
  return m;
}

export function deliverySnapshot(consign: ConsignFacts = { byProduct: {} }): DeliverySnapshot {
  const errors: DeliverySnapshot['errors'] = [];
  const cat = loadCatalog();
  const cards = cardPool();
  const orders = loadOrders();
  const shopByGoods = goodsShopIndex();
  const listings = loadListings();

  const ordersByGoods = new Map<string, { order_no: string; status: number; amount: number; at: number; kami: number }[]>();
  for (const o of Object.values(orders)) {
    const g = o.goods_no ?? '';
    if (!g) continue;
    const arr = ordersByGoods.get(g) ?? [];
    arr.push({ order_no: o.order_no, status: o.order_status, amount: o.order_amount, at: o.order_time, kami: (o.card_items ?? []).length });
    ordersByGoods.set(g, arr);
  }

  const goods: DeliveryGoodsRow[] = cat.goods.map((g) => {
    const eff = goodsWithStock(g);
    const pool = cards[g.goods_no] ?? [];
    const used = pool.filter((c) => c.used).length;
    const ph = pool.some((c) => isPlaceholder(c.card_pwd));
    const by = ordersByGoods.get(g.goods_no) ?? [];
    const last = by.length ? by.reduce((a, b) => (b.at >= a.at ? b : a)) : null;

    const listing = listings[g.goods_no];
    const fact = listing?.product_id ? consign.byProduct[String(listing.product_id)] : undefined;
    const hasFact = Boolean(fact);

    return {
      goods_no: g.goods_no,
      goods_name: g.goods_name,
      shop: shopByGoods.get(g.goods_no) ?? null,
      consign_active: hasFact ? fact!.active : null,
      consign_note: hasFact ? (fact!.active ? '已启用（授权只读结论）' : '未启用（授权只读结论）') : undefined,
      template_id: fact?.template_id ?? null,
      price_fen: g.price,
      stock_mode: g.stock_mode === 'shared' ? 'shared' as const : 'pool' as const,
      on_shelf: eff.status === 1,
      cards_total: pool.length,
      cards_used: used,
      cards_free: pool.length - used,
      placeholder: ph,
      product_id: listing?.product_id ?? null,
      last_order_no: last?.order_no ?? null,
      last_order_at: last ? new Date(last.at * 1000).toISOString() : null,
      last_order_status: last?.status ?? null,
      // 本地台账里 card_items 就是「是否已出卡」的硬证据（无外网依赖）
      last_order_kami: last ? last.kami : null,
      updated_at: g.update_time ? new Date(g.update_time * 1000).toISOString() : '',
    };
  });

  const byShop: DeliverySnapshot['byShop'] = {};
  for (const g of goods) {
    const k = g.shop ?? '(未知)';
    const s = byShop[k] ?? { total: 0, consignActive: 0, consignUnknown: 0, recentOrders: 0 };
    s.total++;
    if (g.consign_active === true) s.consignActive++;
    else if (g.consign_active === null) s.consignUnknown++;
    if (g.last_order_no) s.recentOrders++;
    byShop[k] = s;
  }

  const recentOrders = Object.values(orders)
    .map((o) => ({
      order_no: o.order_no,
      goods_no: o.goods_no ?? '',
      goods_name: o.goods_name,
      status: o.order_status,
      amount_fen: o.order_amount,
      at: new Date(o.order_time * 1000).toISOString(),
      shop: o.goods_no ? (shopByGoods.get(o.goods_no) ?? null) : null,
    }))
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 50);

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      dataDir: '',
      realData: cat.goods.length > 0,
      consignFactsInjected: Object.keys(consign.byProduct).length > 0,
    },
    shops: [],
    byShop,
    goods,
    recentOrders,
    candidates: goods
      .filter((g) => !g.last_order_no && g.cards_free > 0)
      .map((g) => ({ goods_no: g.goods_no, shop: g.shop, reason: '有卡未发、近期无订单（或订单未走网关）' })),
    errors,
  };
}

/**
 * 本地预检（纯只读，不联网、不写任何东西）。
 * 检查：货源自查（catalog 在架）、卡密池与占位、店铺归属已知、台账 product_id、
 * 最近订单是否发出。返回问题清单，供「发货排查」商品详情弹窗展示。
 */
export function deliveryPreflight(goodsNo: string): { ok: boolean; goods_no: string; issues: DeliveryPreflightIssue[]; at: string } {
  const cat = loadCatalog();
  const cards = cardPool();
  const orders = loadOrders();
  const shopByGoods = goodsShopIndex();
  const listings = loadListings();

  const issues: DeliveryPreflightIssue[] = [];
  const g: Goods | undefined = cat.goods.find((x) => x.goods_no === goodsNo);
  if (!g) {
    return { ok: false, goods_no: goodsNo, at: new Date().toISOString(), issues: [] };
  }

  const pool = cards[g.goods_no] ?? [];
  if (pool.length === 0) {
    issues.push({ level: 'blocker', field: 'cards', message: '卡密池为空：买家拍下后无内容可发' });
  } else {
    const used = pool.filter((c) => c.used).length;
    const free = pool.length - used;
    if (free === 0) issues.push({ level: 'blocker', field: 'cards', message: '卡密池已全部用完，需补卡' });
    if (pool.some((c) => isPlaceholder(c.card_pwd))) {
      issues.push({ level: 'warn', field: 'cards', message: '存在占位/联调内容，买家可能收到无效字符串' });
    }
  }

  const shop = shopByGoods.get(goodsNo);
  if (!shop) {
    issues.push({ level: 'warn', field: 'shop', message: '草稿未绑定已授权店铺（user_name 缺失），无法确认归属账号' });
  }

  const eff = goodsWithStock(g);
  if (eff.status !== 1) {
    issues.push({ level: 'warn', field: 'shelf', message: '货源商品当前为下架状态' });
  }

  const listing = listings[goodsNo];
  if (!listing?.product_id) {
    issues.push({ level: 'warn', field: 'listing', message: '草稿台账无 product_id：商品可能从未创建/上架' });
  }

  const by = Object.values(orders).filter((o) => o.goods_no === goodsNo);
  if (!by.length) {
    issues.push({ level: 'info', field: 'orders', message: '网关侧无该商品订单（历史订单可能走的是进销存，需外网 order/list 核实）' });
  } else {
    const last = by.reduce((a, b) => (b.order_time >= a.order_time ? b : a));
    if ((last.card_items?.length ?? 0) === 0) {
      issues.push({ level: 'warn', field: 'orders', message: `最近订单 ${last.order_no} 无卡密记录（可能标记发货但未出卡）` });
    }
  }

  return {
    ok: issues.every((i) => i.level === 'info'),
    goods_no: goodsNo,
    issues,
    at: new Date().toISOString(),
  };
}