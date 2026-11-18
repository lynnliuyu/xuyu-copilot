#!/usr/bin/env node
/**
 * 进销存订单巡检（**只读**，绝不发货）
 *
 * 背景：758 个商品是走「进销存」API 上架的，但发货链路当初是按「虚拟货源」设计的
 *   → 买家拍下后闲管家不会回调我们 → 从来没人自动发过货。
 * 在写自动发货之前，必须先搞清楚：
 *   ① `order/list` 返回什么（已实测：**列表就带全字段**，含 goods.product_id/outer_id/title/images）
 *   ② 有哪些订单没发（`order/kam/list` 为空 = 我方没发过卡）
 *   ③ 订单能不能稳定映射回商品编号（→ 卡密池里那一份内容）
 *
 * 本脚本只 import 三个查询接口，**没有任何写接口**（dummy/send、ship、refund 都没有），
 * 参数写错也不可能发出去任何东西。
 *
 * 用法：
 *   npx tsx scripts/order-probe.ts                     最近 30 天
 *   npx tsx scripts/order-probe.ts --days 365          拉全部历史
 *   npx tsx scripts/order-probe.ts --unmapped          只看认不出商品的订单
 *   npx tsx scripts/order-probe.ts --order <订单号>    单查一单（含卡密）
 *   npx tsx scripts/order-probe.ts --json out/o.json   原始数据落盘
 *   npx tsx scripts/order-probe.ts --shape             只看 dummy/send 请求体形状（不发）
 *
 * 退出码：0 无待处理；2 有「有内容但没发」的订单；1 调用失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOrders, getOrderKamiList } from '../packages/goofish-adapter/src/api';
import { getClient, usingErpCredentials, GOOFISH_APP_NAME } from '../packages/goofish-adapter/src/config';
import { EP, SEND_WAY } from '../packages/goofish-adapter/src/endpoints';
import { cardPool, loadCatalog, isShared } from '../packages/xgj-gateway/src/store';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const val = (n: string, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const DAYS = Number(val('days', '30')) || 30;
const LIMIT = Number(val('limit', '50')) || 50;
const ONE = val('order');
const STATUS = val('status') ? Number(val('status')) : undefined;
const ONLY_UNMAPPED = flag('unmapped');
const COPY = flag('copy');
const SHAPE = flag('shape');
const JSON_OUT = val('json');
const VERBOSE = flag('verbose');

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  c: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
const line = (n = 78) => '─'.repeat(n);
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[\s\-_/·、，,.|【】\[\]()（）+*'"!！?？:：]/g, '');
const fmt = (ts?: number) => (ts ? new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—');

/* ---------------- 商品编号映射 ---------------- */
interface Hit {
  code: string;
  via: string;
}
const byProductId = new Map<number, Hit>();
const byTitle = new Map<string, Hit>();
const byOuterId = new Set<string>();

/** ① 上架台账：product_id → 商品编号 */
try {
  const led = JSON.parse(fs.readFileSync(path.join(PROJ, 'drafts/.listings.json'), 'utf8')) as Record<
    string,
    { product_id?: number; title?: string }
  >;
  for (const [code, v] of Object.entries(led)) {
    if (v?.product_id) byProductId.set(Number(v.product_id), { code, via: '台账' });
    if (v?.title) byTitle.set(norm(v.title), { code, via: '台账标题' });
  }
} catch (e) {
  console.warn(C.y(`⚠️ 读不到 drafts/.listings.json：${(e as Error).message}`));
}

/** ② 草稿 publish_shop[].title → 商品编号 */
let draftCount = 0;
try {
  const dir = path.join(PROJ, 'drafts');
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    draftCount++;
    let d: any;
    try {
      d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    byOuterId.add(String(d?.code ?? ''));
    for (const ps of d?.publish_shop ?? []) if (ps?.title) byTitle.set(norm(ps.title), { code: d.code, via: '草稿' });
  }
} catch (e) {
  console.warn(C.y(`⚠️ 读草稿目录失败：${(e as Error).message}`));
}

/** ③ 货源目录 goods_name → 编号（兜底） */
const catalog = loadCatalog();
const cards = cardPool();
const goodsByNo = new Map(catalog.goods.map((g) => [g.goods_no, g]));
for (const g of catalog.goods) if (g.goods_name) byTitle.set(norm(g.goods_name), { code: g.goods_no, via: '货源名' });
for (const k of Object.keys(cards)) byOuterId.add(k);

function matchByTitle(title?: string): Hit | undefined {
  const t = norm(title);
  if (!t) return undefined;
  const exact = byTitle.get(t);
  if (exact) return exact;
  if (t.length < 10) return undefined;
  for (const [k, v] of byTitle) if (k.length >= 10 && (k.includes(t) || t.includes(k))) return { ...v, via: `${v.via}·模糊` };
  return undefined;
}

/** 订单 → 商品编号。outer_id 最准（就是建商品时写的编号），其次 product_id，最后标题 */
function mapOrder(o: any): { hit?: Hit; why: string } {
  const g = o.goods ?? {};
  const outer = String(g.outer_id ?? '').trim();
  if (outer) {
    if (byOuterId.has(outer)) return { hit: { code: outer, via: 'outer_id' }, why: '' };
    return { why: `outer_id=${outer} 不是我们的编号` };
  }
  const pid = Number(g.product_id ?? 0);
  if (pid && byProductId.has(pid)) return { hit: byProductId.get(pid), why: '' };
  const t = matchByTitle(g.title);
  if (t) return { hit: t, why: '' };
  return { why: pid ? `product_id=${pid} 不在台账` : '无 product_id 无标题' };
}

/** 预测会发哪条卡密（不消耗） */
function predictCard(code: string) {
  const pool = cards[code] ?? [];
  const goods = goodsByNo.get(code);
  const shared = goods ? isShared(goods) : false;
  const unused = pool.filter((c) => !c.used);
  return { pool, unused, shared, pick: shared ? pool[0] : unused[0] };
}

/* ---------------- --shape：只拼请求，不发 ---------------- */
if (SHAPE) {
  const req = getClient().buildRequest(EP.orderDummySend, { order_no: '<订单号>', send_way: 1 });
  console.log(C.b('\n无需物流发货 —— 请求形状（**未发送**）\n'));
  console.log(`  路径    POST ${EP.orderDummySend}`);
  console.log(`  查询串  ${req.url.split('?')[1].replace(/sign=[^&]+/, 'sign=<签名>').replace(/appid=[^&]+/, 'appid=<appKey>')}`);
  console.log(`  请求体  ${req.body}`);
  console.log(`\n  send_way：${Object.entries(SEND_WAY).map(([k, v]) => `${k}=${v}`).join(' ／ ')}`);
  console.log(C.y('\n  ⚠️ 仍未验证：这接口是「只把订单标记已发货」还是「能把卡密文本推给买家」。\n     真实语义只能等一笔真实订单确认 —— 本脚本不发，给不出答案。\n'));
  process.exit(0);
}

/* ---------------- 拉订单 ---------------- */
interface Row {
  no: string;
  status: number;
  time: number;
  amount: number;
  shop: string;
  buyer: string;
  title: string;
  productId: number;
  itemId: number;
  outerId: string;
  refund: number;
  mapped?: Hit;
  missWhy: string;
  kami: number | null; // null = 未查
  raw: any;
}

async function fetchAll(): Promise<any[]> {
  const all: any[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 40; page++) {
    let r: { list: any[]; total?: number };
    try {
      r = await listOrders({ page_no: page, page_size: 50, ...(STATUS !== undefined ? { order_status: STATUS } : {}) });
    } catch (e) {
      console.error(C.r(`\n❌ order/list 调用失败：${(e as Error).message}`));
      console.error(C.dim('   403 → 出口 IP 不在白名单；401 → 签名错误；100001 → 读 msg。'));
      console.error(C.dim('   若本机 IP 没白名单，就在 134 上跑：ssh xgj134 "docker exec xgj-admin npx tsx /app/scripts/order-probe.ts"'));
      process.exit(1);
    }
    const list = r?.list ?? [];
    let fresh = 0;
    for (const o of list) if (!seen.has(o.order_no)) { seen.add(o.order_no); all.push(o); fresh++; }
    process.stdout.write(`\r  已拉取 ${all.length} 单${r?.total ? ` / 共 ${r.total}` : ''}   `);
    if (list.length < 50 || fresh === 0) break;
    if (r?.total && all.length >= r.total) break;
  }
  process.stdout.write('\r' + ' '.repeat(46) + '\r');
  return all;
}

/* ---------------- 主流程 ---------------- */
console.log(C.b('\n📋 进销存订单巡检（只读）'));
console.log(C.dim(`   应用：${GOOFISH_APP_NAME() || '(未命名)'}　凭证：${usingErpCredentials() ? '进销存专用' : '回落到旧值 ⚠️'}`));
console.log(C.dim(`   映射：product_id ${byProductId.size} · 标题 ${byTitle.size} · 草稿 ${draftCount} · 卡密池 ${Object.keys(cards).length}`));
console.log(C.dim('   只用 order/list 与 order/kam/list —— 没有任何写接口\n'));

const rawOrders = ONE ? [{ order_no: ONE }] : await fetchAll();
const cutoff = ONE ? 0 : Date.now() - DAYS * 86400_000;

const rows: Row[] = rawOrders
  .filter((o) => {
    const t = (o.pay_time || o.create_time || 0) * 1000;
    return ONE ? true : !t || t >= cutoff;
  })
  .map((o) => {
    const g = o.goods ?? {};
    const m = mapOrder(o);
    return {
      no: o.order_no,
      status: Number(o.order_status ?? -1),
      time: o.pay_time || o.create_time || 0,
      amount: Number(o.pay_amount ?? 0),
      shop: o.seller_name ?? '',
      buyer: o.buyer_nick ?? '',
      title: String(g.title ?? ''),
      productId: Number(g.product_id ?? 0),
      itemId: Number(g.item_id ?? 0),
      outerId: String(g.outer_id ?? ''),
      refund: Number(o.refund_status ?? 0),
      mapped: m.hit,
      missWhy: m.why,
      kami: null,
      raw: o,
    };
  })
  .sort((a, b) => b.time - a.time);

if (!rows.length) {
  console.log(C.y(`最近 ${DAYS} 天没有订单。`));
  console.log(C.dim('  → 试 --days 365 拉全部历史。\n'));
  process.exit(0);
}

/* 概览 */
const sum = rows.reduce((s, r) => s + r.amount, 0);
const dates = rows.map((r) => r.time).filter(Boolean).sort((a, b) => a - b);
console.log(`订单 ${C.b(String(rows.length))} 笔 · 实收 ${C.b('¥' + (sum / 100).toFixed(2))} · ${fmt(dates[0])} ~ ${fmt(dates[dates.length - 1])}`);

const stDist = new Map<number, number>();
const stMoney = new Map<number, number>();
for (const r of rows) {
  stDist.set(r.status, (stDist.get(r.status) ?? 0) + 1);
  stMoney.set(r.status, (stMoney.get(r.status) ?? 0) + r.amount);
}
const ST_GUESS: Record<number, string> = {
  21: '待发货？',
  22: '已发货/待收货？',
  23: '退款完结？',
  24: '已关闭？',
};
console.log(`\n${C.b('状态分布')}`);
for (const [k, n] of [...stDist].sort((a, b) => a[0] - b[0])) {
  console.log(`  status=${String(k).padEnd(3)} ${String(n).padStart(4)} 单  ¥${((stMoney.get(k) ?? 0) / 100).toFixed(2).padStart(9)}  ${C.dim(ST_GUESS[k] ?? '')}`);
}
const refunded = rows.filter((r) => r.refund === 5).length;
console.log(`  其中退款完结(refund_status=5)：${refunded} 单`);

/* 映射率 */
const mappedRows = rows.filter((r) => r.mapped);
console.log(`\n${C.b('商品映射')}　${mappedRows.length}/${rows.length} 能认出发货编号`);
if (mappedRows.length < rows.length) {
  const miss = rows.filter((r) => !r.mapped);
  const byPid = new Map<string, { n: number; title: string }>();
  for (const r of miss) {
    const k = String(r.productId);
    const e = byPid.get(k) ?? { n: 0, title: r.title };
    e.n++;
    byPid.set(k, e);
  }
  console.log(`  ${C.y(`${miss.length} 单认不出`)}，涉及 ${byPid.size} 个商品（多为早期手工上的老品）：`);
  [...byPid].sort((a, b) => b[1].n - a[1].n).slice(0, 10).forEach(([pid, v]) =>
    console.log(`    ${String(v.n).padStart(3)} 单  product_id=${pid.padEnd(17)} ${String(v.title).slice(0, 34)}`),
  );
  if (byPid.size > 10) console.log(C.dim(`    ……另有 ${byPid.size - 10} 个`));
}

/* 逐单核对未发货的 */
const candidates = (ONLY_UNMAPPED ? rows.filter((r) => !r.mapped) : rows).slice(0, LIMIT);
console.log(`\n${C.b('逐单核对')}（查卡密 ${candidates.length} 单${LIMIT < rows.length ? `，共 ${rows.length}` : ''}）`);
console.log(C.dim('   kami=0 表示闲管家那边这笔单没有任何卡密记录 → 我方从未发货\n'));

for (const [i, r] of candidates.entries()) {
  try {
    r.kami = (await getOrderKamiList(r.no)).filter((k) => String(k?.kami_text ?? '').trim()).length;
  } catch (e) {
    r.kami = -1;
    if (VERBOSE) console.log(C.dim(`  ${r.no} kam/list 失败：${(e as Error).message}`));
  }
  const sent = (r.kami ?? 0) > 0;
  const ok = r.mapped && predictCard(r.mapped.code).pick;
  const badge = sent ? C.g('已发卡') : ok ? C.y('待补发') : C.r('无法发');
  console.log(`${String(i + 1).padStart(3)}. ${C.b(r.no)}  ${badge}  ${C.dim(`${fmt(r.time)}  ¥${(r.amount / 100).toFixed(2)}`)}`);
  console.log(`     ${String(r.title).slice(0, 52) || '(无标题)'}`);
  if (r.mapped) {
    const p = predictCard(r.mapped.code);
    const note = p.pick ? `未用 ${p.unused.length} 条` : C.r('卡密池为空');
    console.log(`     编号 ${C.c(r.mapped.code)} ${C.dim(`(${r.mapped.via})`)}　${note}`);
  } else {
    console.log(`     ${C.r('认不出')} ${C.dim(r.missWhy)}`);
  }
  if (r.kami === -1) console.log('     ' + C.dim('卡密查询失败（不影响其它单）'));
}
if (LIMIT < rows.length) console.log(C.dim(`\n  ……还有 ${rows.length - LIMIT} 单未查，加 --limit 调大`));

/* 汇总 */
console.log('\n' + line());
const pending = rows.filter((r) => r.kami === 0);
const fixable = pending.filter((r) => r.mapped && predictCard(r.mapped.code).pick);
console.log(C.b('结论'));
console.log(`  确认未发货：${C.y(String(pending.length))} 单（本次核对了 ${candidates.length} 单）`);
console.log(`  其中「有内容、只差发出去」：${C.g(String(fixable.length))} 单`);
if (fixable.length) {
  console.log(`\n  ${C.b('待补发清单')}（人工补发可直接用，或等自动发货上线）`);
  for (const r of fixable.slice(0, 30)) console.log(`    ${r.no}  ${r.mapped!.code.padEnd(18)} ${String(r.title).slice(0, 30)}`);
  if (fixable.length > 30) console.log(C.dim(`    ……另有 ${fixable.length - 30} 单`));
}

if (COPY) {
  const mdLines: string[] = [];
  console.log('\n' + '='.repeat(78));
  console.log(C.b('补发文本（复制给买家即可）'));
  console.log(C.dim('  内容取自卡密池里「未使用」的第一条，与自动发货将来会发的完全一致。'));
  console.log('='.repeat(78));
  for (const r of fixable) {
    const pick = predictCard(r.mapped!.code).pick!;
    const body = String(pick.card_pwd ?? '').trim();
    console.log(`\n${C.b('订单')} ${r.no}　${C.dim(fmt(r.time))}`);
    console.log(`${C.b('买家')} ${r.buyer || '(未知)'}　${C.dim(r.shop)}`);
    console.log(`${C.b('商品')} ${String(r.title).slice(0, 46)}　${C.c(r.mapped!.code)}　¥${(r.amount / 100).toFixed(2)}`);
    console.log(C.dim('── 以下整段复制 ─────────────────────────────────────────────'));
    console.log(body);
    console.log(C.dim('─────────────────────────────────────────────────────────────'));

    mdLines.push(
      `### ${r.no}`,
      '',
      `- 买家：${r.buyer || '(未知)'}　店铺：${r.shop}`,
      `- 商品：${String(r.title).slice(0, 60)}　编号 \`${r.mapped!.code}\``,
      `- 实付：¥${(r.amount / 100).toFixed(2)}　下单：${fmt(r.time)}`,
      '',
      '```text',
      body,
      '```',
      '',
      '---',
      '',
    );
  }
  console.log(C.dim(`\n共 ${fixable.length} 单。发完记得让它们别再出现在下一次巡检里（本脚本只读，不会自己标记）。\n`));

  const MD = val('md');
  if (MD) {
    const p = path.isAbsolute(MD) ? MD : path.join(PROJ, MD);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      [
        '# 待补发订单清单',
        '',
        `> 生成时间 ${new Date().toLocaleString('zh-CN')}　共 **${fixable.length}** 单　（\`npm run order:probe -- --copy --md out/待补发清单.md\`）`,
        '',
        '**怎么做**：闲鱼 App → 我卖出的 → 找到对应订单 → 发给买家 → 回订单点「发货」（或告诉我，我用 dummy/send 批量标记）。',
        '',
        '---',
        '',
        ...mdLines,
      ].join('\n'),
      'utf8',
    );
    console.log(`清单已写入：${p}\n`);
  }
}

if (JSON_OUT) {
  const p = path.isAbsolute(JSON_OUT) ? JSON_OUT : path.join(PROJ, JSON_OUT);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify(
      {
        probed_at: new Date().toISOString(),
        days: DAYS,
        total: rows.length,
        orders: rows.map((r) => ({
          order_no: r.no,
          order_status: r.status,
          paid_at: fmt(r.time),
          amount_fen: r.amount,
          shop: r.shop,
          title: r.title,
          product_id: r.productId,
          item_id: r.itemId,
          outer_id: r.outerId || undefined,
          mapped_code: r.mapped?.code ?? null,
          mapped_via: r.mapped?.via ?? null,
          kami_count: r.kami,
          raw: r.raw,
        })),
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\n原始数据：${p}`);
}

console.log(C.dim('\n本次只读，线上状态没有任何变化。'));
console.log(C.dim('下一步：实现「拉单 → 匹配编号 → 出卡 → dummy/send 标记已发」，先拿 1 单灰度。\n'));
process.exit(fixable.length ? 2 : 0);
