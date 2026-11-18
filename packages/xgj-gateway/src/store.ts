/**
 * 网关的数据层：商品目录 + 卡密池 + 订单台账 + 订阅记录。
 *
 * ## 两种用法
 *
 * 1. **默认（文件存储）**：直接调本模块导出的函数，数据放 `XGJ_DATA_DIR`。
 *    这是本项目与 Docker 部署走的路子，零依赖、可直接挂卷。
 * 2. **嵌入（自定义数据源）**：其他项目实现 `GatewayStore` 接口，
 *    交给 `createHandlers(store)` / `createServer({ store })`。
 *    这样商品、卡密可以来自你自己的数据库或 HTTP 服务，不必迁就 JSON 文件。
 *
 * ## 设计取舍
 * - 默认用 JSON 文件而非数据库：网关要独立部署到公网，零依赖意味着
 *   可以直接 scp 过去跑，运维成本最低。
 * - 写入用「临时文件 + rename」，保证原子性，避免进程被杀时写坏数据。
 * - 卡密出库必须落台账：闲管家会重试，若不记账可能同一次下单消耗两张卡。
 * - 读盘按 mtime 做进程内缓存：`goods/list` 会对每个商品算库存，
 *   758 个商品逐次解析 376 KB 的 JSON 实测要 9.5 秒，闲管家的下拉框会超时。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CardItem, Goods, OrderData } from './types';
import { GOODS_STATUS } from './types';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 数据目录：默认包内 data/，可用 XGJ_DATA_DIR 覆盖（部署时指向挂载卷） */
export function dataDir(): string {
  return process.env.XGJ_DATA_DIR
    ? path.resolve(process.env.XGJ_DATA_DIR)
    : path.resolve(HERE, '..', 'data');
}

export interface MerchantConfig {
  /** 商户号，对应「货源授权信息」里的 AppKey 字段 */
  mch_id: string;
  /** 商户名，仅用于日志可读性 */
  name?: string;
  /** 返回给闲管家的余额（分），必须 > 0 */
  balance: number;
}

export interface Catalog {
  merchant: MerchantConfig;
  goods: Goods[];
}

/** 卡密池里的一条。对网盘场景，card_pwd 就是「分享链接 + 提取码」 */
export interface CardRecord {
  card_no?: string;
  card_pwd: string;
  used: boolean;
  /** 被哪笔管家订单消耗 */
  order_no?: string;
  used_at?: number;
}

export interface OrderRecord extends OrderData {
  goods_no: string;
  biz_order_no: string;
  created_at: number;
}

/** 订阅记录（「订阅商品变更通知」接口写入，我们只如实应答，不主动推送） */
export interface SubscriptionRecord {
  goods_type: number;
  goods_no: string;
  token: string;
  notify_url: string;
  subscribe_time: number;
}

/* ========================================================================
 * 可注入的数据源接口
 *
 * 其他项目只需实现这个接口，就能把网关接到自己的商品/卡密体系上。
 * 方法语义与下面的文件实现一一对应，实现时请保持同样的幂等要求：
 *   · claim()  必须原子地占用卡密；库存不足返回 null（调用方回 1102）
 *   · saveOrder() 之后再 claim 同一 order_no，必须命中 findOrder 的幂等短路
 * ====================================================================== */

export interface GatewayStore {
  /** 数据目录（仅用于日志/自检展示；自定义实现可返回标识串） */
  readonly location: string;
  /** 商户信息；balance 必须 > 0，否则闲管家保存应用时会失败 */
  merchant(): MerchantConfig;
  loadCatalog(): Catalog;
  saveCatalog(c: Catalog): void;
  findGoods(goodsNo: string): Goods | undefined;
  /** 对外暴露的库存口径：带库存叠加的商品视图 */
  goodsWithStock(g: Goods): Goods;
  /** 可售数量 */
  availableStock(goodsNo: string): number;
  cardPool(): Record<string, CardRecord[]>;
  saveCardPool(pool: Record<string, CardRecord[]>): void;
  isShared(g: { stock_mode?: string }): boolean;
  /** 原子出库；返回 null 表示库存不足 */
  claimCards(goodsNo: string, qty: number, orderNo: string): CardItem[] | null;
  /** 回滚已占用的卡密（下单失败时） */
  releaseCards(orderNo: string): number;
  loadOrders(): Record<string, OrderRecord>;
  findOrder(orderNo: string): OrderRecord | undefined;
  saveOrder(rec: OrderRecord): void;
  subscribeGoods(rec: Omit<SubscriptionRecord, 'subscribe_time'>): SubscriptionRecord;
  unsubscribeGoods(goodsNo: string, token: string): boolean;
  listSubscriptions(): SubscriptionRecord[];
}

/* ========================================================================
 * 默认实现：JSON 文件
 * ====================================================================== */

export function isShared(g: { stock_mode?: string }): boolean {
  return g.stock_mode === 'shared';
}

function readJsonAt<T>(dir: string, file: string, fallback: T): T {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch (e) {
    throw new Error(`数据文件损坏：${p}\n${(e as Error).message}`);
  }
}

function writeJsonAt(dir: string, file: string, value: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

/**
 * 建一个绑定到固定目录的文件存储。
 * 缓存按实例隔离，因此同一进程里可以有多个互不干扰的 store（便于测试）。
 */
export function createJsonStore(dir: string = dataDir()): GatewayStore {
  const root = path.resolve(dir);
  let catalogCache: { mtimeMs: number; data: Catalog } | null = null;
  let cardsCache: { mtimeMs: number; data: Record<string, CardRecord[]> } | null = null;

  const loadCatalogFile = (): Catalog => {
    const p = path.join(root, 'catalog.json');
    try {
      const st = fs.statSync(p);
      if (catalogCache && catalogCache.mtimeMs === st.mtimeMs) return catalogCache.data;
    } catch {
      /* 文件不存在时走下面 */
    }
    const c = readJsonAt<Catalog>(root, 'catalog.json', {
      merchant: { mch_id: '', balance: 999999 },
      goods: [],
    });
    if (!c.merchant) c.merchant = { mch_id: '', balance: 999999 };
    if (!Array.isArray(c.goods)) c.goods = [];
    try {
      catalogCache = { mtimeMs: fs.statSync(p).mtimeMs, data: c };
    } catch {
      /* ignore */
    }
    return c;
  };

  const loadCardsFile = (): Record<string, CardRecord[]> => {
    const p = path.join(root, 'cards.json');
    try {
      const st = fs.statSync(p);
      if (cardsCache && cardsCache.mtimeMs === st.mtimeMs) return cardsCache.data;
      const data = readJsonAt<Record<string, CardRecord[]>>(root, 'cards.json', {});
      cardsCache = { mtimeMs: st.mtimeMs, data };
      return data;
    } catch {
      return readJsonAt<Record<string, CardRecord[]>>(root, 'cards.json', {});
    }
  };

  const toCardItem = (c: CardRecord): CardItem =>
    c.card_no ? { card_no: c.card_no, card_pwd: c.card_pwd } : { card_pwd: c.card_pwd };

  const store: GatewayStore = {
    location: root,

    merchant: () => loadCatalogFile().merchant,
    loadCatalog: loadCatalogFile,
    saveCatalog: (c) => writeJsonAt(root, 'catalog.json', c),
    findGoods: (goodsNo) => loadCatalogFile().goods.find((g) => g.goods_no === goodsNo),

    cardPool: loadCardsFile,
    saveCardPool: (pool) => writeJsonAt(root, 'cards.json', pool),
    isShared,

    availableStock(goodsNo) {
      const pool = loadCardsFile()[goodsNo] ?? [];
      return pool.filter((c) => !c.used).length;
    },

    goodsWithStock(g) {
      const pool = loadCardsFile()[g.goods_no] ?? [];
      // 共享链接模式：只要池里有一条可用内容，就能持续供货
      if (isShared(g)) {
        const usable = pool.length > 0;
        return {
          ...g,
          stock: usable ? (g.shared_stock ?? 9999) : 0,
          status: usable ? g.status : GOODS_STATUS.OFF,
        };
      }
      const stock = pool.filter((c) => !c.used).length;
      return {
        ...g,
        stock,
        // 卡密用尽 = 事实下架，避免买家下单后拿不到货
        status: stock > 0 ? g.status : GOODS_STATUS.OFF,
      };
    },

    claimCards(goodsNo, qty, orderNo) {
      const all = loadCardsFile();
      const pool = all[goodsNo] ?? [];
      const goods = loadCatalogFile().goods.find((g) => g.goods_no === goodsNo);

      if (goods && isShared(goods)) {
        if (pool.length === 0) return null;
        // 共享模式不消耗卡密，取第一条重复返回
        return Array.from({ length: qty }, () => toCardItem(pool[0]));
      }

      const free = pool.filter((c) => !c.used);
      if (free.length < qty) return null;

      const picked = free.slice(0, qty);
      const now = Math.floor(Date.now() / 1000);
      for (const p of picked) {
        p.used = true;
        p.order_no = orderNo;
        p.used_at = now;
      }
      writeJsonAt(root, 'cards.json', all);
      return picked.map(toCardItem);
    },

    releaseCards(orderNo) {
      const all = loadCardsFile();
      let n = 0;
      for (const pool of Object.values(all)) {
        for (const c of pool) {
          if (c.used && c.order_no === orderNo) {
            c.used = false;
            delete c.order_no;
            delete c.used_at;
            n++;
          }
        }
      }
      if (n) writeJsonAt(root, 'cards.json', all);
      return n;
    },

    loadOrders: () => readJsonAt<Record<string, OrderRecord>>(root, 'orders.json', {}),
    findOrder(orderNo) {
      return store.loadOrders()[orderNo];
    },
    saveOrder(rec) {
      const all = store.loadOrders();
      all[rec.order_no] = rec;
      writeJsonAt(root, 'orders.json', all);
    },

    subscribeGoods(rec) {
      const all = readJsonAt<Record<string, SubscriptionRecord>>(root, 'subscriptions.json', {});
      const k = `${rec.goods_no}::${rec.token}`;
      // 幂等：已存在则保留原 subscribe_time，重试不会刷新时间
      const saved: SubscriptionRecord = {
        ...rec,
        subscribe_time: all[k]?.subscribe_time ?? Math.floor(Date.now() / 1000),
      };
      all[k] = saved;
      writeJsonAt(root, 'subscriptions.json', all);
      return saved;
    },

    unsubscribeGoods(goodsNo, token) {
      const all = readJsonAt<Record<string, SubscriptionRecord>>(root, 'subscriptions.json', {});
      const k = `${goodsNo}::${token}`;
      if (!all[k]) return false;
      delete all[k];
      writeJsonAt(root, 'subscriptions.json', all);
      return true;
    },

    listSubscriptions: () =>
      Object.values(readJsonAt<Record<string, SubscriptionRecord>>(root, 'subscriptions.json', {})),
  };

  return store;
}

/** 首次运行时生成一份可用的样例数据，让网关开箱能跑通自测 */
export function seedCheckout(store: GatewayStore): { created: boolean; location: string } {
  const existing = store.loadCatalog();
  if (existing.goods.length) return { created: false, location: store.location };

  const now = Math.floor(Date.now() / 1000);
  const mchId = process.env.XGJ_MCH_ID || 'bd-to-xy';
  store.saveCatalog({
    merchant: { mch_id: mchId, name: '网盘资源智能家居/MCP 货源', balance: 99999900 },
    goods: [
      {
        goods_no: 'BD-DEMO-001',
        goods_type: 2,
        goods_name: '【联调样例】测试商品 · 卡密池模式（请勿购买）',
        price: 100,
        stock: 999,
        status: GOODS_STATUS.ON,
        update_time: now,
      },
      {
        goods_no: 'BD-DEMO-002',
        goods_type: 2,
        goods_name: '【联调样例】测试商品 · 共享链接模式（请勿购买）',
        price: 100,
        stock: 9999,
        status: GOODS_STATUS.ON,
        update_time: now,
        stock_mode: 'shared',
        shared_stock: 9999,
      },
    ],
  });
  store.saveCardPool({
    'BD-DEMO-001': [
      { card_no: 'DEMO-1', card_pwd: '这是卡密池模式的一条样例卡密（一单一链，发完即止）', used: false },
      { card_no: 'DEMO-2', card_pwd: '样例卡密 2', used: false },
      { card_no: 'DEMO-3', card_pwd: '样例卡密 3', used: false },
    ],
    'BD-DEMO-002': [
      { card_pwd: '这是共享链接模式的样例内容（所有买家收到同一条，不消耗）', used: false },
    ],
  });
  writeJsonAt(store.location, 'orders.json', {});
  return { created: true, location: store.location };
}

/* ========================================================================
 * 内存实现：给「接自己数据源」的项目一个可直接抄的骨架，也用于测试
 * ====================================================================== */

/**
 * 进程内存储，**重启即丢**。
 *
 * 用途：
 *   · 单测里不想碰文件系统时
 *   · 展示 `GatewayStore` 接口该怎么实现（把下面每个方法换成你的数据库调用即可）
 *
 * ⚠️ 出库必须保证原子性。这里用单线程的同步逻辑就够；
 *    换成数据库时请务必用事务或 `UPDATE ... WHERE used = false` 这类条件写，
 *    否则闲管家重试会造成同一张卡发两次。
 */
export function createMemoryStore(seed?: {
  merchant?: MerchantConfig;
  goods?: Goods[];
  cards?: Record<string, CardRecord[]>;
}): GatewayStore {
  let merchant: MerchantConfig = seed?.merchant ?? { mch_id: 'memory', balance: 99999900 };
  let goods: Goods[] = seed?.goods ? [...seed.goods] : [];
  let cards: Record<string, CardRecord[]> = seed?.cards
    ? structuredClone(seed.cards)
    : {};
  const orders: Record<string, OrderRecord> = {};
  const subs: Record<string, SubscriptionRecord> = {};

  const store: GatewayStore = {
    location: 'memory://',

    merchant: () => merchant,
    loadCatalog: () => ({ merchant, goods }),
    saveCatalog(c) {
      merchant = c.merchant;
      goods = c.goods;
    },
    findGoods: (goodsNo) => goods.find((g) => g.goods_no === goodsNo),

    cardPool: () => cards,
    saveCardPool(pool) {
      cards = pool;
    },
    isShared,
    availableStock: (goodsNo) => (cards[goodsNo] ?? []).filter((c) => !c.used).length,

    goodsWithStock(g) {
      const pool = cards[g.goods_no] ?? [];
      if (isShared(g)) {
        const usable = pool.length > 0;
        return { ...g, stock: usable ? (g.shared_stock ?? 9999) : 0, status: usable ? g.status : GOODS_STATUS.OFF };
      }
      const stock = pool.filter((c) => !c.used).length;
      return { ...g, stock, status: stock > 0 ? g.status : GOODS_STATUS.OFF };
    },

    claimCards(goodsNo, qty, orderNo) {
      const pool = cards[goodsNo] ?? [];
      const g = goods.find((x) => x.goods_no === goodsNo);
      const toItem = (c: CardRecord): CardItem =>
        c.card_no ? { card_no: c.card_no, card_pwd: c.card_pwd } : { card_pwd: c.card_pwd };

      if (g && isShared(g)) {
        if (!pool.length) return null;
        return Array.from({ length: qty }, () => toItem(pool[0]));
      }
      const free = pool.filter((c) => !c.used);
      if (free.length < qty) return null;
      const picked = free.slice(0, qty);
      const now = Math.floor(Date.now() / 1000);
      for (const c of picked) {
        c.used = true;
        c.order_no = orderNo;
        c.used_at = now;
      }
      return picked.map(toItem);
    },

    releaseCards(orderNo) {
      let n = 0;
      for (const pool of Object.values(cards)) {
        for (const c of pool) {
          if (c.used && c.order_no === orderNo) {
            c.used = false;
            delete c.order_no;
            delete c.used_at;
            n++;
          }
        }
      }
      return n;
    },

    loadOrders: () => orders,
    findOrder: (orderNo) => orders[orderNo],
    saveOrder(rec) {
      orders[rec.order_no] = rec;
    },

    subscribeGoods(rec) {
      const k = `${rec.goods_no}::${rec.token}`;
      const saved: SubscriptionRecord = {
        ...rec,
        subscribe_time: subs[k]?.subscribe_time ?? Math.floor(Date.now() / 1000),
      };
      subs[k] = saved;
      return saved;
    },
    unsubscribeGoods(goodsNo, token) {
      const k = `${goodsNo}::${token}`;
      if (!subs[k]) return false;
      delete subs[k];
      return true;
    },
    listSubscriptions: () => Object.values(subs),
  };

  return store;
}

/* ========================================================================
 * 默认单例：供本项目既有脚本与 CLI 使用（行为与重构前一致）
 * ====================================================================== */

let defaultStore: GatewayStore | null = null;
let defaultDir = '';

/** 取默认 store。XGJ_DATA_DIR 在首次调用后变化不会生效（与原实现的模块级缓存一致） */
export function getStore(): GatewayStore {
  const dir = dataDir();
  if (!defaultStore || defaultDir !== dir) {
    defaultStore = createJsonStore(dir);
    defaultDir = dir;
  }
  return defaultStore;
}

export const loadCatalog = (): Catalog => getStore().loadCatalog();
export const saveCatalog = (c: Catalog): void => getStore().saveCatalog(c);
export const findGoods = (goodsNo: string): Goods | undefined => getStore().findGoods(goodsNo);
export const cardPool = (): Record<string, CardRecord[]> => getStore().cardPool();
export const saveCardPool = (pool: Record<string, CardRecord[]>): void => getStore().saveCardPool(pool);
export const availableStock = (goodsNo: string): number => getStore().availableStock(goodsNo);
export const goodsWithStock = (g: Goods): Goods => getStore().goodsWithStock(g);
export const claimCards = (goodsNo: string, qty: number, orderNo: string): CardItem[] | null =>
  getStore().claimCards(goodsNo, qty, orderNo);
export const releaseCards = (orderNo: string): number => getStore().releaseCards(orderNo);
export const loadOrders = (): Record<string, OrderRecord> => getStore().loadOrders();
export const findOrder = (orderNo: string): OrderRecord | undefined => getStore().findOrder(orderNo);
export const saveOrder = (rec: OrderRecord): void => getStore().saveOrder(rec);
export const subscribeGoods = (rec: Omit<SubscriptionRecord, 'subscribe_time'>): SubscriptionRecord =>
  getStore().subscribeGoods(rec);
export const unsubscribeGoods = (goodsNo: string, token: string): boolean =>
  getStore().unsubscribeGoods(goodsNo, token);
export const listSubscriptions = (): SubscriptionRecord[] => getStore().listSubscriptions();

/** 兼容旧调用点：首次运行时生成样例数据 */
export function ensureSeed(): { created: boolean; dir: string } {
  const r = seedCheckout(getStore());
  return { created: r.created, dir: r.location };
}
