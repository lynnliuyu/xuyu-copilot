/**
 * 后台管理端（本地）。
 *
 * 为什么不塞进网关进程：
 *   网关是**要暴露到公网**的（闲管家得能调它），而管理端能改价格、改卡密内容、
 *   发布商品——两者安全等级完全不同。分开跑、管理端只绑 127.0.0.1，
 *   公网那一侧就永远碰不到管理接口。
 *
 * 两大块功能：
 *   A. 货源管理（虚拟货源链路）—— 读写 packages/xgj-gateway/data
 *      商品上下架 / 改价 / 卡密增删改 / 订单与订阅查看
 *   B. 上架流水线（进销存链路）—— 读写 drafts/
 *      资源条目（两侧网盘 + 分享链接）→ 生成发布草稿 → 体检 → 按序上架
 *
 * 启动：npm run admin      默认 http://127.0.0.1:8790
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dataDir,
  loadCatalog,
  saveCatalog,
  saveCardPool,
  cardPool,
  loadOrders,
  goodsWithStock,
  listSubscriptions,
  type CardRecord,
} from '../../xgj-gateway/src/store';
import { GOODS_STATUS } from '../../xgj-gateway/src/types';
// ---- 上架流水线（进销存侧）----
import {
  loadResources,
  upsertResource,
  patchResource,
  removeResource,
  validateResource,
  checkNaming,
  emptySide,
  writeJsonAtomic,
  CATEGORIES,
  categoryOf,
  defaultPriceFor,
  SHOPS,
  DRAFTS_DIR,
  type ResourceEntry,
} from './resources';
import { scanBaidu, scanQuark, scanQuarkByPath } from './scan';
import { generateDraft, loadDrafts, loadListings, VERIFIED_PUBLISH_CONFIG } from './publish-draft';
// ---- 商品图（渲染 + 上传）----
import { renderCard } from './card-render';
import { specFor } from './card-spec';
import { uploadImage, mediaReady, pingMedia } from './media';
import { validateDraft, normalizeDraft, type ProductDraft } from '../../goofish-adapter/src/draft';
import { deliverySnapshot, deliveryPreflight, type ConsignFacts } from './delivery';
import { runListingAction, XgjWriteError } from '../../goofish-adapter/src/listing';
import { getProduct } from '../../goofish-adapter/src/api';
import {
  describeListingState,
  listingStateFromRemoteStatus,
  REMOTE_STATE_LABEL,
  type RemoteListingState,
} from '../../goofish-adapter/src/state';
// ---- 发布闸门（体检 + 节流）。⚠️ 护栏必须在服务端，见 publish-guard.ts 顶部说明 ----
import {
  guardStatus,
  takeSlot,
  RateLimited,
  checkOne,
  checkMany,
  listCodes,
  loadResults,
  saveResults,
  preflightCapabilities,
  bannedWords,
  loadExclusions,
  exclude,
  unexclude,
  MIN_INTERVAL_SEC,
} from './publish-guard';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, '..', 'public');

const PORT = Number(process.env.ADMIN_PORT ?? 8790) || 8790;
/**
 * 默认只绑本机（管理端能改卡密、能发布商品，绝不对外）。
 * ⚠️ 放进容器时必须设 ADMIN_HOST=0.0.0.0：容器内的 127.0.0.1 是容器自己的回环，
 *    端口映射根本到不了它 —— 会出现「容器跑着、页面打不开」这种最难查的状态。
 *    对外仍然只暴露在 127.0.0.1（见 docker-compose.yml 的 ports）。
 */
const HOST = process.env.ADMIN_HOST || '127.0.0.1';

/* ------------------------------------------------------------------ 发货排查（只读）
 * /api/delivery/state      —— 聚合：店铺/商品筛选 + 配置状态 + 库存 + 模板 + 最近发货 + 取数错误
 * /api/delivery/preflight  —— 单商品本地预检（不联网、不写）
 *
 * consign 事实（商品侧发货设置是否启用）来自授权只读产物：
 *   可选文件 <repo>/out/consign-facts.json（gitignore 内，不入库）：
 *     { "byProduct": { "<product_id>": { "active": true, "kind_way": 4, "template_id": 178…, "at": "…" } } }
 *   无该文件时 consign_active=null，前端如实显示「缺数据」而非编造结论。
 */
function loadConsignFacts(): ConsignFacts {
  try {
    const p = path.resolve(HERE, '..', '..', '..', 'out', 'consign-facts.json');
    if (!fs.existsSync(p)) return { byProduct: {} };
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (raw && typeof raw.byProduct === 'object' && !Array.isArray(raw.byProduct)) return raw as ConsignFacts;
    return { byProduct: {} };
  } catch {
    return { byProduct: {} };
  }
}

/* ------------------------------------------------------------------ 店铺状态
 * 为什么需要：2026-10-09 实例 —— 用户要求把 DiPlay 发到「顺和服饰平价超市」，
 * 而这家店 10-08 被封控、商品全部 down_shelved，发过去只会白跑一次（还占掉 300s 名额），
 * 更糟的是会重演「同一 code 绑了两个店铺记录」的坑。
 *
 * 名单文件：packages/xgj-admin/data/shop-status.json
 *   { "店铺 user_name": { "until": "2026-10-15", "reason": "被封控 7 天" } }
 * 到 until 之前拒绝发布；要强行发布传 { forceShop: true }。
 */
const SHOP_STATUS_FILE = path.resolve(HERE, '..', 'data', 'shop-status.json');

export interface ShopBlock {
  until?: string;
  reason?: string;
}

export function loadShopStatus(): Record<string, ShopBlock> {
  try {
    if (!fs.existsSync(SHOP_STATUS_FILE)) return {};
    return JSON.parse(fs.readFileSync(SHOP_STATUS_FILE, 'utf8')) as Record<string, ShopBlock>;
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------ 工具

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/* ============================================================
   公网入口健康探测（action: health.public）
   —— 为什么放服务端：浏览器直连公网域名是跨域，no-cors 拿不到状态码。
   —— 为什么不能只看「HTTP 通不通」：2026-10-11 那次 DNS 漂移，公网照样
      返回 404（也算「有响应」），但响应根本不是我们的网关 → 必须判内容特征。
      那次买家拍单不发货、我们这边一条回调都没收到，却没有任何提示。
   ============================================================ */
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://xgj.fmkj.top';
/** 响应真的来自我们自己的网关吗（只看状态码会漏判） */
const looksLikeOurs = (b: string) => /闲管家|Method Not Allowed|商户不存在|goofish/i.test(b);

async function probeOnce(
  url: string,
  timeoutMs = 12000,
): Promise<{ reachable: boolean; status: number; body: string; err?: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    return { reachable: true, status: r.status, body: (await r.text()).slice(0, 200) };
  } catch (e: any) {
    return { reachable: false, status: 0, body: '', err: String(e?.cause?.code || e?.name || e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function healthPublic() {
  // ① 闲管家回调链路 —— 买家拍单 → 发货全靠它
  const a = await probeOnce(`${PUBLIC_BASE}/goofish/open/info`);
  const aOk = a.reachable && looksLikeOurs(a.body);
  // ② 微信关键词 —— 故意不带签名，期望被拒 403（403 恰好证明打到了本服务）
  const b = await probeOnce(`${PUBLIC_BASE}/wechat`);
  const bOk = b.reachable && (b.status === 403 || /signature|签名/i.test(b.body));

  const hints: string[] = [];
  if (!aOk) {
    if (a.reachable && a.status === 404 && !looksLikeOurs(a.body)) {
      hints.push(`公网返回 404 且响应不像本网关 → 先查 DNS：${PUBLIC_BASE} 是否被指到了别的服务器（这不是隧道问题）`);
    } else if (a.reachable && a.status === 502) {
      hints.push('502 → 服务器 Caddy 在，但上游 8787 没通：隧道断了，或服务器上该端口被残留 sshd-session 占着');
    } else if (!a.reachable) {
      // ⚠️ ENOTFOUND/EAI_AGAIN = 域名**根本解析不出来**（云解析里还没有这条记录），
      //    和「隧道断了」完全不是一回事 —— 提示分开写，否则会把人往错方向带。
      hints.push(/ENOTFOUND|EAI_AGAIN|ENODATA/i.test(String(a.err))
        ? `${PUBLIC_BASE} 域名解析不到（${a.err}）→ 云解析里可能还没加这条 A 记录（应指向 150.158.3.164）`
        : `连不上（${a.err}）→ 隧道 / Caddy 可能挂了`);
    } else {
      hints.push(`响应异常（HTTP ${a.status}）`);
    }
  }

  return {
    ok: true,
    healthy: aOk,
    base: PUBLIC_BASE,
    at: new Date().toISOString(),
    checks: [
      {
        name: '闲管家回调（买家拍单→自动发货）',
        ok: aOk,
        status: a.status,
        detail: aOk
          ? '响应来自本网关 ✓'
          : a.reachable
            ? `HTTP ${a.status}：${a.body.slice(0, 70)}`
            : `连不上：${a.err}`,
      },
      {
        name: '微信关键词回复',
        ok: bOk,
        status: b.status,
        detail: bOk
          ? '响应来自本服务（验签被拒 = 链路通）'
          : b.reachable
            ? `HTTP ${b.status}：${b.body.slice(0, 70)}`
            : `连不上：${b.err}`,
      },
    ],
    hints,
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const yuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`;

// ------------------------------------------------------------------ 快照 A：货源

function snapshot() {
  const cat = loadCatalog();
  const cards = cardPool();
  const orders = loadOrders();
  const subs = listSubscriptions();

  const goods = cat.goods.map((g) => {
    const pool = cards[g.goods_no] ?? [];
    // goodsWithStock 会把 stock / status 修正成「按真实卡密数算」的结果，
    // 避免 catalog 里手写的 stock 和卡密池对不上导致超卖
    const eff = goodsWithStock(g);
    return {
      goods_no: g.goods_no,
      goods_name: g.goods_name,
      goods_type: g.goods_type,
      price: g.price,
      status: g.status,
      effective_status: eff.status,
      stock_mode: g.stock_mode ?? 'pool',
      shared_stock: g.shared_stock ?? null,
      raw_stock: g.stock,
      effective_stock: eff.stock,
      update_time: g.update_time,
      cards_total: pool.length,
      cards_used: pool.filter((c) => c.used).length,
      cards_free: pool.filter((c) => !c.used).length,
    };
  });

  const orderList = Object.values(orders).sort(
    (a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0),
  );
  const ok = orderList.filter((o) => o.order_status === 20);
  const stats = {
    goods_total: goods.length,
    goods_on: goods.filter((g) => g.effective_status === GOODS_STATUS.ON).length,
    goods_off: goods.filter((g) => g.effective_status !== GOODS_STATUS.ON).length,
    orders_total: orderList.length,
    orders_success: ok.length,
    orders_pending: orderList.filter((o) => o.order_status === 10).length,
    orders_failed: orderList.filter((o) => o.order_status === 30).length,
    revenue_fen: ok.reduce((s, o) => s + (Number(o.order_amount) || 0), 0),
    cards_delivered: goods.reduce((s, g) => s + g.cards_used, 0),
  };

  return {
    meta: {
      dataDir: dataDir(),
      adminPort: PORT,
      gatewayPort: Number(process.env.XGJ_PORT ?? 8787) || 8787,
      generatedAt: new Date().toISOString(),
    },
    merchant: cat.merchant,
    stats,
    goods,
    cards,
    orders: orderList,
    subscriptions: subs,
  };
}

// ------------------------------------------------------------------ 快照 B：上架流水线

/**
 * 台账里的 `state` 存的是**已经映射过**的 RemoteListingState（如 `on_sale`），
 * 所以这里不能再拿它去调用 listingStateFromRemoteStatus —— 那等于二次映射，
 * 会把 `on_sale` 当成「认不出的状态」而显示成「状态待确认」。
 *
 * 为了兼容历史/外部写入的原始数字 product_status，两种形态都接。
 */
function listingStateLabel(v: unknown): string {
  if (typeof v === 'string' && v in REMOTE_STATE_LABEL) {
    return describeListingState(v as RemoteListingState);
  }
  return describeListingState(listingStateFromRemoteStatus(v));
}

function publishSnapshot() {
  const resources = loadResources();
  const drafts = loadDrafts();
  const listings = loadListings();
  /** 上次体检的缓存结论（命令行/后台跑过就有），用来在队列里直接打标 */
  const pfResults = loadResults();
  /** 永久排除名单（违规 / 法定违禁品 / 侵权），这些绝不再发布 */
  const exclusions = loadExclusions();

  const draftByCode = new Map(drafts.map((d) => [d.code, d]));

  const resourceList = Object.values(resources).map((r) => {
    const issues = validateResource(r);
    const code = r.draft_code?.trim() || undefined;
    const gen = code ? draftByCode.get(code) : undefined;
    const listing = gen ? listings[gen.code] : undefined;

    // 草稿层面的体检（用 goofish-adapter 同一套规则，保证和 CLI 结论一致）
    let draftIssues: ReturnType<typeof validateDraft> = [];
    if (gen) {
      try {
        draftIssues = validateDraft(normalizeDraft(JSON.parse(JSON.stringify(gen.draft))));
      } catch (e: any) {
        draftIssues = [{ level: 'blocker', field: 'draft', message: `草稿解析失败：${e?.message}` }];
      }
    }

    const blockers = draftIssues.filter((i) => i.level === 'blocker');
    const warns = draftIssues.filter((i) => i.level === 'warn');

    /** 待发布队列里的状态：
     *  pending       —— 尚未生成草稿 / 未发布
     *  blocked       —— 有阻塞项，不能发
     *  ready         —— 可以发
     *  published     —— 已发布到闲管家（带线上状态）
     */
    // ⚠️⚠️ 「有 product_id」≠「已上架」。2026-10-08 实测：286 个商品接口受理成功、
    //    product_id 也记了，但线上其实是闲管家**草稿**（product_status=21），
    //    若一律当 published，队列将永远不再重试它们（商品就永久停在那里）。
    //    → 只把「确实不在草稿态」的算已发布。
    const stuckInDraft = listing?.state === 'draft';
    const ex = code ? exclusions[code] : undefined;
    let status: 'pending' | 'blocked' | 'ready' | 'published' | 'excluded' = 'pending';
    // ⚠️ 排除优先级最高：即便是 ready 或已发布，也不允许再发
    if (ex) status = 'excluded';
    else if (listing && !stuckInDraft) status = 'published';
    else if (gen && blockers.length) status = 'blocked';
    else if (gen) status = 'ready';

    // 体检结论（缓存）：blocked = 违规（绝不能发）；warned_count = 疑似需人工确认
    const pfc = code ? pfResults[code] : undefined;
    const preflight = pfc
      ? {
          blocked: pfc.block.length,
          warned: pfc.warn.length,
          images: pfc.images,
          with_images: pfc.with_images,
          at: pfc.at,
          block: pfc.block,
          warn: pfc.warn,
        }
      : null;

    return {
      ...r,
      naming: checkNaming(r.baidu?.folders ?? [], r.quark?.folders ?? []),
      resource_issues: issues,
      draft_code: code ?? null,
      draft: gen?.draft ?? null,
      draft_issues: draftIssues,
      blockers: blockers.length,
      warns: warns.length,
      preflight,
      /** 永久排除信息（有值 = 不再发布） */
      exclusion: ex ? { ...ex, state_label: '已排除（不再发布）' } : null,
      listing: listing
        ? { ...listing, state_label: listingStateLabel(listing.state) }
        : null,
      status,
    };
  });

  // 排序：待发布的在前，已发布的在后；已排除的沉到最底（不用再看）
  const order = { blocked: 0, ready: 1, pending: 2, published: 3, excluded: 4 } as const;
  resourceList.sort((a, b) => order[a.status] - order[b.status]);

  // 没有关联资源条目的「孤儿草稿」也要能看到（比如手工建的联调草稿）
  const orphanDrafts = drafts
    .filter((d) => !resourceList.some((r) => r.draft_code === d.code))
    .map((d) => {
      const issues = validateDraft(normalizeDraft(JSON.parse(JSON.stringify(d.draft))));
      const blockers = issues.filter((i) => i.level === 'blocker');
      const listing = listings[d.code];
      return {
        code: d.code,
        draft: d.draft,
        draft_issues: issues,
        blockers: blockers.length,
        listing: listing
          ? { ...listing, state_label: listingStateLabel(listing.state) }
          : null,
        status: listing ? 'published' : blockers.length ? 'blocked' : 'ready',
      };
    });

  return {
    meta: {
      draftsDir: DRAFTS_DIR,
      verifiedConfig: VERIFIED_PUBLISH_CONFIG,
      generatedAt: new Date().toISOString(),
    },
    /** ⭐ 发布闸门当前状态：节流间隔、下次可发时间、今日已发次数 */
    guard: guardStatus(),
    /** 体检缓存的时间戳（无缓存则为 null），前端据此判断「结论是不是旧的」 */
    preflight_at: resourceList.map((r) => r.preflight?.at).filter(Boolean).sort().pop() ?? null,
    /** 类别定义（含默认价、默认店铺），前端用它渲染标签、筛选与「套用默认价」 */
    categories: CATEGORIES,
    /** 已授权的闲鱼店铺（user_name ↔ 后台显示名 的对照） */
    shops: SHOPS,
    resources: resourceList,
    orphanDrafts,
    stats: {
      resources_total: resourceList.length,
      ready: resourceList.filter((r) => r.status === 'ready').length,
      blocked: resourceList.filter((r) => r.status === 'blocked').length,
      published: resourceList.filter((r) => r.status === 'published').length,
      /** ⚠️ 体检判定违规、绝不能发的数量（会直接被发布闸门拦下） */
      preflight_blocked: resourceList.filter((r) => (r.preflight?.blocked ?? 0) > 0).length,
      /** 体检有疑似项、需人工确认的数量 */
      preflight_warned: resourceList.filter((r) => (r.preflight?.blocked ?? 0) === 0 && (r.preflight?.warned ?? 0) > 0).length,
      /** 还没体检过的（结论缺失） */
      preflight_unknown: resourceList.filter((r) => r.draft_code && !r.preflight).length,
      /** 永久排除、不再发布的数量 */
      excluded: resourceList.filter((r) => r.status === 'excluded').length,
      /** 真正还能发的（ready 且未被排除） */
      publishable: resourceList.filter((r) => r.status === 'ready').length,
      /** 按类别的数量分布，key = category id（'' 表示未分类） */
      by_category: resourceList.reduce<Record<string, number>>((acc, r) => {
        const k = r.category || '';
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
    },
  };
}

// ------------------------------------------------------------------ 写操作 A：货源

function fail(msg: string) {
  return { ok: false, error: msg };
}

/** 商品上下架 / 改价 / 卡密增删改 / 新建商品 */
function mutate(action: string, p: Record<string, string>, body: any) {
  const cat = loadCatalog();
  const goodsNo = p.goodsNo;
  const idx = Number(p.index);

  if (action === 'goods.create') {
    const no = String(body?.goods_no ?? '').trim();
    const name = String(body?.goods_name ?? '').trim();
    const price = Number(body?.price);
    const mode = body?.stock_mode === 'shared' ? 'shared' : 'pool';
    const card = String(body?.card_pwd ?? '').trim();
    if (!no || !name) return fail('商品编码与名称必填');
    if (!Number.isInteger(price) || price < 0) return fail('价格必须是非负整数（单位：分）');
    if (cat.goods.some((g) => g.goods_no === no)) return fail(`商品编码 ${no} 已存在`);
    if (!card) return fail('至少要填一条卡密/交付内容');

    cat.goods.push({
      goods_no: no,
      goods_type: 2,
      goods_name: name,
      price,
      stock: mode === 'shared' ? Number(body?.shared_stock) || 9999 : 1,
      status: GOODS_STATUS.ON,
      update_time: Math.floor(Date.now() / 1000),
      ...(mode === 'shared' ? { stock_mode: 'shared' as const, shared_stock: Number(body?.shared_stock) || 9999 } : {}),
    });
    saveCatalog(cat);

    const pool = cardPool();
    pool[no] = [{ card_pwd: card, used: false }];
    saveCardPool(pool);
    return { ok: true, message: `已新建货源商品 ${no}（${mode === 'shared' ? '一链多发' : '一单一链'}）` };
  }

  const g = cat.goods.find((x) => x.goods_no === goodsNo);
  if (!g) return fail(`商品不存在：${goodsNo}`);

  if (action === 'goods.status') {
    const status = Number(body?.status);
    if (status !== GOODS_STATUS.ON && status !== GOODS_STATUS.OFF) return fail('status 只能是 1 或 2');
    g.status = status;
    g.update_time = Math.floor(Date.now() / 1000);
    saveCatalog(cat);
    return { ok: true, message: `${goodsNo} 已${status === GOODS_STATUS.ON ? '上架' : '下架'}` };
  }

  if (action === 'goods.price') {
    const price = Number(body?.price);
    if (!Number.isInteger(price) || price < 0) return fail('价格必须是非负整数（单位：分）');
    g.price = price;
    g.update_time = Math.floor(Date.now() / 1000);
    saveCatalog(cat);
    return { ok: true, message: `${goodsNo} 价格已改为 ${yuan(price)}` };
  }

  if (action.startsWith('cards.')) {
    const pool = cardPool();
    const list: CardRecord[] = pool[goodsNo] ?? [];

    if (action === 'cards.add') {
      const txt = String(body?.card_pwd ?? '').trim();
      if (!txt) return fail('交付内容不能为空');
      list.push(body?.card_no ? { card_no: String(body.card_no), card_pwd: txt, used: false } : { card_pwd: txt, used: false });
      pool[goodsNo] = list;
      saveCardPool(pool);
      return { ok: true, message: `${goodsNo} 已新增 1 条交付内容（共 ${list.length} 条）` };
    }

    if (action === 'cards.update') {
      if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return fail('卡密序号无效');
      const txt = String(body?.card_pwd ?? '').trim();
      if (!txt) return fail('交付内容不能为空');
      if (list[idx].used) {
        // 已发出的内容改掉会和订单台账对不上，明确拦下来
        if (body?.force !== true) return fail('这条已经发给过买家，改动会让订单台账对不上。确认要改请再点一次「强制替换」');
      }
      list[idx].card_pwd = txt;
      pool[goodsNo] = list;
      saveCardPool(pool);
      return { ok: true, message: `${goodsNo} 第 ${idx + 1} 条已更新` };
    }

    if (action === 'cards.remove') {
      if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return fail('卡密序号无效');
      if (list[idx].used) return fail('已发出的内容不能删除（订单台账会失去依据）');
      const [removed] = list.splice(idx, 1);
      pool[goodsNo] = list;
      saveCardPool(pool);
      return { ok: true, message: `${goodsNo} 已删除 1 条，剩余 ${list.length} 条` };
    }
  }

  return fail(`未知操作：${action}`);
}

// ------------------------------------------------------------------ 写操作 B：上架流水线

/** 归一化前端传上来的资源条目，补齐缺失结构，避免 undefined 到处飞 */
function normalizeResourceInput(body: any): ResourceEntry {
  const side = (s: any, fallbackRoot: string) => ({
    ...emptySide(fallbackRoot),
    ...(s ?? {}),
    folders: Array.isArray(s?.folders) ? s.folders.map((x: any) => String(x)) : [],
  });
  const id = String(body?.id ?? body?.name ?? '').trim();
  const out: ResourceEntry = {
    id,
    name: String(body?.name ?? id).trim(),
    display_name: String(body?.display_name ?? '').trim(),
    baidu: side(body?.baidu, ''),
    quark: side(body?.quark, ''),
    cover_images: Array.isArray(body?.cover_images)
      ? body.cover_images.map((x: any) => String(x)).filter(Boolean)
      : [],
    card_subtitle: body?.card_subtitle ? String(body.card_subtitle).trim() : undefined,
    draft_code: body?.draft_code ? String(body.draft_code) : undefined,
    price_fen: Number(body?.price_fen) || undefined,
    notes: body?.notes ? String(body.notes) : undefined,
    created_at: '',
    updated_at: '',
  };
  // category 用「未传则不动」语义：不传这个键时，upsertResource 的浅合并会保留原值
  if (typeof body?.category === 'string') out.category = body.category.trim() || undefined;
  // 同理：shop 只在显式传入时才写。传空字符串 = 清除覆盖（回到类别默认店铺）
  if (typeof body?.shop === 'string') out.shop = body.shop.trim() || undefined;
  // 同理：platforms 只在显式传入时才写，否则保留原有值
  if (Array.isArray(body?.platforms)) {
    out.platforms = body.platforms.map((x: any) => String(x).trim()).filter(Boolean);
  }
  return out;
}

async function mutatePipeline(action: string, body: any): Promise<any> {
  switch (action) {
    /* ---------- 资源条目 ---------- */
    case 'resource.save': {
      const input = normalizeResourceInput(body);
      if (!input.id) return fail('资源标识（id）必填');
      if (!input.display_name) return fail('展示名必填');

      // 未填售价但选了类别 → 自动套用该类别默认价
      // （用户要求：Blender 插件类默认 1.88 元）
      let usedDefault = false;
      if ((!input.price_fen || input.price_fen <= 0) && input.category) {
        const dft = defaultPriceFor(input.category);
        if (dft) {
          input.price_fen = dft;
          usedDefault = true;
        }
      }

      const saved = upsertResource(input);
      const issues = validateResource(saved);
      const blockers = issues.filter((i) => i.level === 'blocker');
      const catName = categoryOf(saved.category)?.name;
      const priceTag = usedDefault
        ? `，已套用「${catName}」默认价 ${(saved.price_fen! / 100).toFixed(2)} 元`
        : '';
      return {
        ok: true,
        message: `资源「${saved.display_name}」已保存${priceTag}${blockers.length ? `（还有 ${blockers.length} 个阻塞项）` : ''}`,
        resource: saved,
        issues,
      };
    }

    /* ---------- 类别 ---------- */
    // 按类别批量改价：把该类别下所有资源（以及它们已生成的草稿）的售价统一成
    // 类别默认价，或调用方指定的价格。避免逐条手改、也避免「资源改了但草稿没改」。
    case 'category.reprice': {
      const catId = String(body?.category ?? '').trim();
      const cat = categoryOf(catId);
      if (!cat) return fail(`未知类别：${catId || '(空)'}`);
      const explicit = Number(body?.price_fen);
      const target =
        Number.isFinite(explicit) && explicit > 0 ? Math.round(explicit) : cat.price_fen;

      const store = loadResources();
      const hits = Object.values(store).filter((r) => r.category === catId);
      if (!hits.length) return { ok: true, message: `「${cat.name}」下暂无资源`, changed: [] };

      const changed: Array<{ id: string; from: number | null; to: number }> = [];
      for (const r of hits) {
        const from = r.price_fen ?? null;
        if (from !== target) {
          patchResource(r.id, { price_fen: target });
          changed.push({ id: r.id, from, to: target });
        }
        // 草稿也要跟着改，否则页面上资源价变了、实际发布用的还是旧价
        const code = r.draft_code?.trim();
        if (!code) continue;
        const file = path.join(DRAFTS_DIR, `${code}.json`);
        if (!fs.existsSync(file)) continue;
        try {
          const d = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (d.price !== target) {
            d.price = target;
            writeJsonAtomic(file, d);
          }
        } catch {
          /* 草稿坏了不影响改价，跳过 */
        }
      }

      return {
        ok: true,
        message: `「${cat.name}」已统一为 ${(target / 100).toFixed(2)} 元，影响 ${hits.length} 个资源（实际改动 ${changed.length} 个）`,
        category: cat,
        changed,
      };
    }

    case 'resource.remove': {
      const id = String(body?.id ?? '');
      if (!id) return fail('缺少 id');
      return removeResource(id) ? { ok: true, message: `已删除资源 ${id}` } : fail(`资源不存在：${id}`);
    }

    case 'resource.scanBaidu': {
      const dir = String(body?.dir ?? '').trim();
      if (!dir) return fail('缺少百度网盘目录路径');
      const r = await scanBaidu(dir);
      return { ok: true, message: `百度侧扫描完成：${r.dirCount} 个目录 / ${r.fileCount} 个文件`, scan: r };
    }

    case 'resource.scanQuark': {
      // 支持传 FID 直接扫，或传路径数组逐级下钻
      const segments = Array.isArray(body?.segments) ? body.segments.map((x: any) => String(x)) : null;
      const r = segments?.length ? await scanQuarkByPath(segments) : await scanQuark(String(body?.fid ?? '0'));
      return { ok: true, message: `夸克侧扫描完成：${r.dirCount} 个目录 / ${r.fileCount} 个文件`, scan: r };
    }

    case 'resource.applyScan': {
      const id = String(body?.id ?? '');
      if (!id) return fail('缺少 id');
      const cur = loadResources()[id];
      if (!cur) return fail(`资源不存在：${id}`);
      const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
      // ⚠️ 必须与已有值合并：patchResource 是浅合并，直接塞 body 会把 share_url/pwd 冲掉
      const patch: Partial<ResourceEntry> = {};
      if (body?.baidu) patch.baidu = { ...cur.baidu, ...body.baidu, scanned_at: stamp } as any;
      if (body?.quark) patch.quark = { ...cur.quark, ...body.quark, scanned_at: stamp } as any;
      const saved = patchResource(id, patch);
      if (!saved) return fail(`资源不存在：${id}`);
      return { ok: true, message: '扫描结果已写入资源条目', resource: saved };
    }

    /* ---------- 草稿 ---------- */
    case 'draft.generate': {
      const id = String(body?.id ?? '');
      const r = loadResources()[id];
      if (!r) return fail(`资源不存在：${id}`);
      const issues = validateResource(r);
      const blockers = issues.filter((i) => i.level === 'blocker');
      if (blockers.length && body?.force !== true) {
        return fail(
          `资源还有 ${blockers.length} 个阻塞项，不能生成发布草稿：` +
            blockers.map((b) => b.message).join('；'),
        );
      }
      const out = generateDraft(r, { overwrite: body?.overwrite === true });
      // 把 code 记回资源条目，方便下次直接关联
      patchResource(id, { draft_code: out.code });
      return {
        ok: true,
        message: out.existed && body?.overwrite !== true
          ? `草稿 ${out.code} 已存在，未覆盖（要重生成请勾选「覆盖」）`
          : `已生成发布草稿 ${out.code}`,
        code: out.code,
        existed: out.existed,
      };
    }

    case 'draft.save': {
      const code = String(body?.code ?? '');
      if (!code) return fail('缺少草稿 code');
      const file = path.join(DRAFTS_DIR, `${code.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
      if (!fs.existsSync(file)) return fail(`草稿不存在：${code}`);
      const draft = JSON.parse(fs.readFileSync(file, 'utf8'));
      const p = body?.patch ?? {};

      if (typeof p.title === 'string') draft.publish_shop[0].title = p.title;
      if (typeof p.content === 'string') draft.publish_shop[0].content = p.content;
      if (p.price !== undefined) {
        const price = Number(p.price);
        if (!Number.isInteger(price) || price <= 0) return fail('价格必须是正整数（单位：分）');
        draft.price = price;
      }
      if (Array.isArray(p.images)) {
        const imgs = p.images.map((x: any) => String(x).trim()).filter(Boolean);
        if (imgs.some((u: string) => !/^https?:\/\//.test(u))) return fail('封面图必须是 http/https 公网地址');
        draft.publish_shop[0].images = imgs;
      }
      if (typeof p.compliance_clean === 'boolean') {
        draft.compliance = {
          clean: p.compliance_clean,
          note: p.compliance_note ?? draft.compliance?.note ?? '',
        };
      }
      if (p.user_name) draft.publish_shop[0].user_name = String(p.user_name);
      if (p.category_id) draft.channel_cat_id = String(p.category_id);

      writeJsonAtomic(file, draft);
      const issues = validateDraft(normalizeDraft(JSON.parse(JSON.stringify(draft))));
      return {
        ok: true,
        message: `草稿 ${code} 已保存（${issues.filter((i) => i.level === 'blocker').length} 个阻塞项）`,
        issues,
      };
    }

    /* ---------- 商品图 ---------- */
    case 'card.generate': {
      const id = String(body?.id ?? '');
      const r = loadResources()[id];
      if (!r) return fail(`资源不存在：${id}`);

      // 1) 渲染（规格从资源条目推断，与 CLI 用同一套规则）
      const spec = specFor(r);
      const out = await renderCard(spec, `${id}-main.png`);

      // 2) 上传（图床没配好就只返回本地结果，不阻塞）
      const ready = mediaReady();
      if (!ready.ready) {
        return {
          ok: true,
          message: `图已生成（1080×1080，${(out.bytes / 1024).toFixed(0)} KB），但图床未配置：${ready.missing.join('、')}`,
          local: out.path,
          spec: { logo: spec.logo, platforms: spec.platforms, title: spec.title },
        };
      }
      const up = await uploadImage(out.path, `${id}-main.png`);

      // 3) 回填（新图放第一位）
      const covers = [up.url, ...((r.cover_images ?? []).filter((u) => u !== up.url))];
      patchResource(id, { cover_images: covers });

      return {
        ok: true,
        message: `已生成并上传（${(up.bytes / 1024).toFixed(0)} KB）→ ${up.url}`,
        url: up.url,
        cover_images: covers,
        spec: { logo: spec.logo, platforms: spec.platforms, title: spec.title, subtitle: spec.subtitle },
      };
    }

    case 'media.ping': {
      const r = await pingMedia();
      return r.ok ? { ok: true, message: r.message, detail: r.detail } : fail(r.message);
    }

    /* ---------- 发布 ---------- */
    case 'publish.run': {
      const code = String(body?.code ?? '');
      if (!code) return fail('缺少草稿 code');
      // 真实写操作，必须显式确认
      if (body?.confirm !== true) return fail('发布是真实上架操作，需要二次确认');

      // ⭐ 永久排除名单：内容违规 / 法定违禁品 / 侵权 —— 绝不再发布。
      // 放在最前面：连体检都不用跑，直接拒。要恢复必须先解除排除（draft.unexclude）。
      const exRec = loadExclusions()[code];
      if (exRec) {
        return {
          ...fail(`草稿 ${code} 已被永久排除，不再发布。原因：${exRec.reason}`),
          code: 'EXCLUDED',
          exclusion: exRec,
        };
      }
      const drafts = loadDrafts();
      const target = drafts.find((d) => d.code === code);
      if (!target) return fail(`草稿不存在：${code}`);
      const draft = normalizeDraft(JSON.parse(JSON.stringify(target.draft)));

      // ⭐ 闸门零：目标店铺可用性。被封控/下架的店铺直接拒（省掉体检与 300s 名额），
      //    要强行发布传 { forceShop: true }。见 data/shop-status.json。
      const shopName = String(draft.publish_shop?.[0]?.user_name ?? '');
      const shopBlock = loadShopStatus()[shopName];
      if (shopBlock && body?.forceShop !== true) {
        const untilTs = shopBlock.until ? Date.parse(shopBlock.until) : NaN;
        if (!Number.isFinite(untilTs) || Date.now() < untilTs) {
          return {
            ...fail(
              `目标店铺「${shopName}」已标记为不可用：${shopBlock.reason ?? '原因未注明'}` +
                (shopBlock.until ? `（有效期至 ${shopBlock.until}）` : '') +
                `。换一家店，或传 forceShop: true 强行发布。`,
            ),
            code: 'SHOP_BLOCKED',
            shop: shopName,
            shop_block: shopBlock,
          };
        }
      }

      const issues = validateDraft(draft);
      const blockers = issues.filter((i) => i.level === 'blocker');
      if (blockers.length) {
        return fail(`还有 ${blockers.length} 个阻塞项，不能发布：` + blockers.map((b) => `${b.field} ${b.message}`).join('；'));
      }

      // ⭐⭐ 闸门一：上架前体检。
      // 2026-10-08 事故：一个 Blender 插件的**封面图带「GPT」字样** → 账号被封控。
      // 所以这里默认**连图片一起查**（图片结果按 URL 缓存，重复发不重扫）。
      if (body?.skipPreflight !== true) {
        const withImages = body?.withImages !== false;
        let pf;
        try {
          pf = await checkOne(code, { text: true, images: withImages });
          // ⚠️ 只写本次真正查过的维度 —— 否则「没查图片」会把已有的图片结论清空
          await saveResults([pf], { text: true, images: withImages });
        } catch (e: any) {
          return {
            ...fail(`上架前体检执行失败，为安全起见已阻止提交：${String(e?.message ?? e).slice(0, 120)}`),
            code: 'PREFLIGHT_ERROR',
          };
        }
        if (pf.block.length) {
          return {
            ...fail(
              `上架前体检未通过（${pf.block.length} 项），已阻止提交：` +
                pf.block.map((x: string) => String(x).split('\n')[0]).join('；'),
            ),
            code: 'PREFLIGHT_BLOCKED',
            preflight: pf,
          };
        }
      }

      // ⭐⭐ 闸门二：发布节流。
      // 必须在上架请求之前占名额 —— 限制的是「发往闲鱼的请求频率」，与成功与否无关。
      // 规则：两次提交至少间隔 MIN_INTERVAL_SEC 秒（默认 300）。
      try {
        takeSlot(code, { force: body?.forceRate === true });
      } catch (e) {
        if (e instanceof RateLimited) {
          return {
            ...fail(e.message),
            code: 'RATE_LIMIT',
            wait_ms: e.waitMs,
            next_at: e.nextAt,
            min_interval_sec: MIN_INTERVAL_SEC,
          };
        }
        throw e;
      }

      const listings = loadListings();
      const productId = body?.recreate === true ? null : (listings[code]?.product_id ?? null);
      const action = body?.recreate === true ? 'publish' : productId ? 'publish' : 'publish';

      try {
        const out = await runListingAction(action as any, {
          draft,
          productId,
          notifyUrl: process.env.GOOFISH_NOTIFY_URL || undefined,
        });
        // ⚠️ 必须把 product_id 记进台账，否则：①「同步状态」查不到，② 页面上
        // 显示成「未发布」，③ 再次点发布可能重复创建商品。2026-10-07 修。
        if (out.productId) {
          const store = loadListings();
          store[code] = {
            product_id: out.productId,
            state: out.state,
            title: draft.publish_shop?.[0]?.title,
            updated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
          };
          writeJsonAtomic(path.join(DRAFTS_DIR, '.listings.json'), store);
        }
        return {
          ok: true,
          message:
            `已提交上架（product_id=${out.productId}）。上架是异步的，稍后点「同步状态」核对真实结果。` +
            (out.notes.length ? ` 提示：${out.notes.join('；')}` : ''),
          product_id: out.productId,
          state: out.state,
          state_label: describeListingState(out.state),
          notes: out.notes,
        };
      } catch (e) {
        if (e instanceof XgjWriteError) {
          // ⭐⭐ 上架接口「报错」≠「没上架」。2026-10-09 实测：DiPlay 明明已在售
          //    （product_status=22 / item_id>0），publish 却返回 XGJ_PUBLISH_FAILED
          //    （真因是"重复上架被平台拒"）。所以失败时必须**反查真实状态**：
          //      ① 页面不能再骗人（否则显示"未发布"，用户会一直重试）
          //      ② 台账必须写 product_id（不写 → 丢了 id → 下次重试可能重复创建商品）
          let verified: {
            product_status: number | null;
            state: string;
            item_id: number;
            online_time: number;
            offline_time: number;
          } | null = null;
          let state: string | undefined;
          if (e.productId) {
            try {
              const detail: any = await getProduct(e.productId);
              const shop = detail?.publish_shop?.[0] ?? {};
              state = listingStateFromRemoteStatus(detail?.product_status);
              verified = {
                product_status: detail?.product_status ?? null,
                state,
                item_id: Number(shop.item_id ?? 0),
                online_time: Number(detail?.online_time ?? 0),
                offline_time: Number(detail?.offline_time ?? 0),
              };
            } catch {
              /* 查不到就按失败处理，至少把 product_id 留住 */
            }
            const store = loadListings();
            store[code] = {
              product_id: e.productId,
              state: state ?? 'unknown',
              title: draft.publish_shop?.[0]?.title,
              updated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
            };
            writeJsonAtomic(path.join(DRAFTS_DIR, '.listings.json'), store);
          }
          // 平台真因在 cause 里（以前被吞掉，排查要绕一大圈）
          const causeMsg = (e as any)?.cause?.message
            ? `　平台返回：${String((e as any).cause.message).slice(0, 160)}`
            : '';
          const reallyOnSale = state === 'on_sale';
          return {
            ...fail(
              reallyOnSale
                ? `接口报了错，但**核对后其实已上架**（product_status=22 / item_id=${verified?.item_id}）——` +
                    `属「重复上架被拒」，不需要重试。${causeMsg}`
                : `${e.message}${causeMsg}`,
            ),
            code: reallyOnSale ? 'PUBLISH_VERIFIED_ON_SALE' : e.code,
            product_id: e.productId,
            verification: verified,
            retry_hint: !e.productId
              ? undefined
              : reallyOnSale
                ? '无需重试：商品已在售。'
                : `商品 ${e.productId} 已在闲管家生成但未上架。修正原因后点「重试上架」，不要新建。`,
          };
        }
        throw e;
      }
    }

    case 'publish.sync': {
      const code = String(body?.code ?? '');
      if (!code) return fail('缺少草稿 code');
      const listing = loadListings()[code];
      if (!listing?.product_id) return fail('这个草稿还没有 product_id（未发布过），无从同步');
      const detail = await getProduct(listing.product_id);
      const state = listingStateFromRemoteStatus((detail as any).product_status);
      // 把最新状态写回台账
      const store = loadListings();
      store[code] = {
        ...store[code],
        state,
        updated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      };
      writeJsonAtomic(path.join(DRAFTS_DIR, '.listings.json'), store);
      return {
        ok: true,
        message: `${code} 线上状态：${describeListingState(state)}`,
        state,
        state_label: describeListingState(state),
        detail: {
          product_id: listing.product_id,
          product_status: (detail as any).product_status,
          publish_status: (detail as any).publish_status,
          item_id: (detail as any).publish_shop?.[0]?.item_id ?? 0,
        },
      };
    }

    case 'guard.status': {
      return { ok: true, guard: guardStatus() };
    }

    /** 公网入口健康（发货链路是否真的可达）—— 给页顶横幅用，见 healthPublic() */
    case 'health.public': {
      return await healthPublic();
    }

    /**
     * 上架前体检（命令行 `npm run preflight` 的接口版）。
     * body: { codes?: string[], all?: boolean, images?: boolean }
     * 不传 codes/all 时默认只查「待发布队列」（ready + blocked）。
     */
    case 'preflight.check': {
      const images = body?.images === true;
      let codes: string[] = [];
      if (Array.isArray(body?.codes) && body.codes.length) {
        codes = body.codes.map((c: unknown) => String(c)).filter(Boolean);
      } else if (body?.all === true) {
        codes = await listCodes();
      } else {
        codes = publishSnapshot()
          .resources.filter((r) => r.draft_code && r.status !== 'published')
          .map((r) => r.draft_code as string);
      }
      codes = [...new Set(codes)];
      if (!codes.length) return { ok: true, results: [], with_images: images, summary: { blocked: 0, warned: 0, clean: 0 }, message: '没有需要体检的草稿' };

      const results = await checkMany(codes, { text: true, images });
      await saveResults(results, { text: true, images });
      const blocked = results.filter((r) => r.block.length).length;
      const warned = results.filter((r) => !r.block.length && r.warn.length).length;
      // ⚠️ 覆盖率必须跟着结果一起回去。引擎按平台选（macOS Vision / Linux tesseract），
      //    tesseract 没有图像分类能力 —— 不说清楚，「无疑似」会被误读成「已查干净」。
      const cap = images ? await preflightCapabilities() : null;
      let message = `体检 ${results.length} 个：${blocked} 个违规（已拦）、${warned} 个疑似、${results.length - blocked - warned} 个正常`;
      if (cap && !cap.labels) {
        message += `；⚠️ 当前图片引擎为 ${cap.engine}，图像分类不可用，「过度暴露」仅由肤色占比兜底`;
      } else if (cap && !cap.ocr) {
        message += `；⚠️ 当前图片引擎不可用（${cap.note}），图片实际未检查`;
      }
      return {
        ok: true,
        results,
        with_images: images,
        engine: cap?.engine ?? null,
        coverage: cap ? { ocr: cap.ocr, labels: cap.labels, skin: cap.skin } : null,
        coverage_note: cap?.note || null,
        summary: { blocked, warned, clean: results.length - blocked - warned },
        message,
      };
    }

    /** 永久排除（不再发布）。body: { codes: string[], reason, hits? } */
    case 'draft.exclude': {
      const codes: string[] = Array.isArray(body?.codes)
        ? body.codes.map((c: unknown) => String(c)).filter(Boolean)
        : body?.code ? [String(body.code)] : [];
      if (!codes.length) return fail('缺少 codes');
      const reason = String(body?.reason ?? '').trim() || '内容违规 / 法定违禁品 / 侵权（未填写具体原因）';
      const hits = Array.isArray(body?.hits) ? body.hits.map((x: unknown) => String(x).slice(0, 200)) : undefined;
      for (const c of codes) exclude(c, reason, hits);
      return { ok: true, message: `已排除 ${codes.length} 个草稿，不再发布` };
    }

    case 'draft.unexclude': {
      const c = String(body?.code ?? '');
      if (!c) return fail('缺少 code');
      unexclude(c);
      return { ok: true, message: `已解除排除：${c}（可以再次发布，但请确认内容已合规）` };
    }

    default:
      return fail(`未知操作：${action}`);
  }
}

// ------------------------------------------------------------------ 路由

function serveStatic(res: http.ServerResponse, file: string): void {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  const ext = path.extname(full);
  const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(full));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      serveStatic(res, 'index.html');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, snapshot());
      return;
    }
    // 上架流水线快照
    if (req.method === 'GET' && url.pathname === '/api/publish/state') {
      sendJson(res, 200, publishSnapshot());
      return;
    }

    // 发货排查快照（只读聚合）。把 SHOPS 与 dataDir 注入进快照，前端无需另一份对照。
    if (req.method === 'GET' && url.pathname === '/api/delivery/state') {
      const snap = deliverySnapshot(loadConsignFacts());
      snap.meta.dataDir = dataDir();
      snap.shops = SHOPS.map((s) => ({ ...s }));
      sendJson(res, 200, snap);
      return;
    }

    // 单商品本地预检（只读，不联网）。
    if (req.method === 'GET' && url.pathname.startsWith('/api/delivery/preflight/')) {
      const goodsNo = decodeURIComponent(url.pathname.slice('/api/delivery/preflight/'.length));
      sendJson(res, 200, deliveryPreflight(goodsNo));
      return;
    }

    /** 违禁词表（后台「上架体检」页展示用）。词表文件：assets/_shared/banned-words.json */
    if (req.method === 'GET' && url.pathname === '/api/banned-words') {
      try {
        sendJson(res, 200, { ok: true, ...(await bannedWords()) });
      } catch (e: any) {
        sendJson(res, 200, { ok: false, error: String(e?.message ?? e) });
      }
      return;
    }

    /* ---------- 货源管理（同步写操作）---------- */
    // POST /api/goods/create
    // POST /api/goods/:no/status | /price
    // POST /api/goods/:no/cards/:sub[/:index]      sub = add | update | remove
    let action = '';
    let goodsNo = '';
    let index = '';
    let m: RegExpMatchArray | null;
    if (url.pathname === '/api/goods/create') {
      action = 'goods.create';
    } else if ((m = url.pathname.match(/^\/api\/goods\/([^/]+)\/(status|price)$/))) {
      action = `goods.${m[2]}`;
      goodsNo = decodeURIComponent(m[1]);
    } else if ((m = url.pathname.match(/^\/api\/goods\/([^/]+)\/cards\/(add|update|remove)(?:\/(\d+))?$/))) {
      action = `cards.${m[2]}`;
      goodsNo = decodeURIComponent(m[1]);
      index = m[3] ?? '';
    }

    if (req.method === 'POST' && action) {
      const raw = await readBody(req);
      let body: any = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, fail('请求体不是合法 JSON'));
        return;
      }
      const out = mutate(action, { goodsNo, index }, body);
      sendJson(res, out.ok ? 200 : 409, out);
      return;
    }

    /* ---------- 上架流水线（异步写操作）---------- */
    // POST /api/pipeline/<action>   action ∈ resource.save | resource.remove |
    //   resource.scanBaidu | resource.scanQuark | resource.applyScan |
    //   draft.generate | draft.save | publish.run | publish.sync
    if (req.method === 'POST' && url.pathname.startsWith('/api/pipeline/')) {
      const pAction = url.pathname.slice('/api/pipeline/'.length);
      const raw = await readBody(req);
      let body: any = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, fail('请求体不是合法 JSON'));
        return;
      }
      const out = await mutatePipeline(pAction, body);
      sendJson(res, out?.ok ? 200 : 409, out);
      return;
    }

    sendJson(res, 404, fail(`未知路径：${url.pathname}`));
  } catch (e: any) {
    sendJson(res, 500, fail(`服务端异常：${e?.message ?? e}`));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  后台管理端已启动`);
  console.log(`  地址：      http://${HOST}:${PORT}`);
  console.log(`  货源数据：  ${dataDir()}`);
  console.log(`  上架草稿：  ${DRAFTS_DIR}`);
  console.log(`  网关端口：  ${process.env.XGJ_PORT ?? 8787}（管理端只绑 127.0.0.1，不对外）`);
  console.log(`\n  Ctrl+C 停止\n`);
});
