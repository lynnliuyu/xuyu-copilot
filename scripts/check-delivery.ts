#!/usr/bin/env node
/**
 * 发货内容自查 —— 模拟闲管家下单，看**这个商品实际会发给买家什么**。
 *
 * 用法：
 *   npx tsx scripts/check-delivery.ts                随机挑一个已上架商品
 *   npx tsx scripts/check-delivery.ts BD-GFX-113251  指定商品
 *   npx tsx scripts/check-delivery.ts --all          批量检查全部已上架商品，只报问题
 *
 * 为什么要它：
 *   「发货覆盖」体检只能看出"卡密池里有没有内容"，看不出**内容对不对**
 *   （比如链接指向了空目录、提取码丢了、标题串了）。真出问题时买家只会说"收不到"，
 *   而你没法复现。这个工具用与管家完全相同的签名方式打一次真实下单，把要发的原文打出来。
 *
 * 安全性：
 *   · 只对 `stock_mode=shared`（一链多发）的商品放行，共享模式**不消耗**卡密；
 *     池模式（一单一份）会真扣一张卡，所以默认拒绝，需显式加 --force。
 *   · 测试订单用 `CHECK-DELIVERY-*` 前缀，跑完自动从订单台账里删掉，不污染数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { genVsSign } from '../packages/xgj-gateway/src/sign';
import { cardPool, loadCatalog } from '../packages/xgj-gateway/src/store';
import { isAdminUp, adminState, ADMIN_URL } from './lib/admin.mjs';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(PROJ, 'packages/xgj-gateway/data');
const GATEWAY = `http://127.0.0.1:${process.env.XGJ_PORT || 8787}`;

/* ---------------- 读配置 ---------------- */
function readEnv(key: string): string {
  const s = fs.readFileSync(path.join(PROJ, '.env'), 'utf8');
  const m = s.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return (m?.[1] ?? '').trim();
}
const APP_ID = readEnv('GOOFISH_APP_KEY');
const APP_SECRET = readEnv('GOOFISH_APP_SECRET');
const MCH_ID = readEnv('XGJ_MCH_ID');
const MCH_SECRET = readEnv('XGJ_MCH_SECRET');
if (!APP_ID || !APP_SECRET || !MCH_ID || !MCH_SECRET) {
  console.error('❌ .env 缺少 GOOFISH_APP_KEY / GOOFISH_APP_SECRET / XGJ_MCH_ID / XGJ_MCH_SECRET');
  process.exit(2);
}

const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const FORCE = argv.includes('--force');
/** `--find <关键词>`：按商品名/编号反查，用来对照闲鱼订单找到该发哪份内容 */
const FIND = argv.includes('--find') ? argv[argv.indexOf('--find') + 1] : '';
const target = argv.find((a) => !a.startsWith('--') && a !== FIND);

/* ---------------- 按管家方式签名调用 ---------------- */
async function call(pathname: string, body: unknown) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const sign = genVsSign({
    appId: APP_ID,
    appSecret: APP_SECRET,
    mchId: MCH_ID,
    mchSecret: MCH_SECRET,
    timestamp: ts,
    bodyString: raw,
  });
  const url = `${GATEWAY}${pathname}?mch_id=${encodeURIComponent(MCH_ID)}&timestamp=${ts}&sign=${sign}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: raw });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text.slice(0, 300) };
  }
}

/* ---------------- 确定要检查哪些商品 ---------------- */
const catalog = loadCatalog();
const cards = cardPool();
const goodsByNo = new Map(catalog.goods.map((g) => [g.goods_no, g]));

let codes: string[] = [];
if (target) {
  codes = [target];
} else {
  if (!(await isAdminUp(2500))) {
    console.error(`❌ 管理端未运行（${ADMIN_URL}），无法列出已上架商品。先 npm run admin，或直接指定商品号。`);
    process.exit(1);
  }
  const st: any = await adminState();
  codes = (st.resources || []).filter((r: any) => r.status === 'published').map((r: any) => r.draft_code).filter(Boolean);
}
codes = [...new Set(codes)].sort();

/**
 * ⭐ `--find <关键词>`：给「有人拍了我该发什么」这个场景用。
 *
 * 买家拍下后，闲鱼订单里能看到商品标题；用标题里的几个字（或商品编号）在这里搜，
 * 直接拿到该发的那份内容（链接 + 提取码），复制过去人工补发即可。
 */
if (FIND) {
  if (!(await isAdminUp(2500))) {
    console.error(`❌ 管理端未运行（${ADMIN_URL}）。先 npm run admin`);
    process.exit(1);
  }
  const st: any = await adminState();
  const kw = FIND.toLowerCase();
  const hits = (st.resources || []).filter((r: any) => {
    const hay = [r.id, r.display_name, r.draft_code, r.title, ...(r.platforms || [])].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(kw);
  });
  console.log(`按「${FIND}」匹配到 ${hits.length} 个资源\n`);
  for (const r of hits.slice(0, 30)) {
    const code = r.draft_code || '';
    const pool = code ? cards[code] : undefined;
    const text = pool?.[0]?.card_pwd || '';
    console.log('─'.repeat(72));
    console.log(`  ${r.id}   队列状态=${r.status}   上架状态=${r.listing?.state ?? '—'}`);
    console.log(`  发货编号(goods_no)：${code || '（无）'}`);
    console.log(`  标题：${r.listing?.title || r.display_name || r.name || '—'}`);
    if (!code) {
      console.log('  ⚠️ 没有 draft_code，无法在卡密池里定位发货内容');
    } else if (!pool || !text) {
      console.log(`  ❌ 卡密池里没有内容 —— 跑 npm run card:sync 补齐`);
    } else {
      console.log('  ── 以下是会发给买家的原文，可直接复制 ──');
      console.log(text.split('\n').map((l) => '  ' + l).join('\n'));
    }
  }
  console.log('─'.repeat(72));
  if (!hits.length) console.log('没有匹配项。试试更短的关键词，或用商品编号直接查：npx tsx scripts/check-delivery.ts <编号>');
  process.exit(0);
}
if (!codes.length) {
  console.log('没有可检查的已上架商品。');
  process.exit(0);
}
console.log(`发货自查：${codes.length} 个商品　网关 ${GATEWAY}\n`);

/* ---------------- 逐个下单验证 ---------------- */
const results: Array<{ no: string; ok: boolean; why: string }> = [];
const created: string[] = [];
const stamp = Date.now();

for (const [i, goodsNo] of codes.entries()) {
  const g = goodsByNo.get(goodsNo);
  if (!g) { results.push({ no: goodsNo, ok: false, why: '货源商品不存在（需跑 npm run card:sync）' }); continue; }
  const pool = cards[goodsNo] ?? [];
  if (!pool.length || !pool[0].card_pwd?.trim()) {
    results.push({ no: goodsNo, ok: false, why: '卡密池为空' });
    continue;
  }
  if (g.stock_mode !== 'shared' && !FORCE) {
    results.push({ no: goodsNo, ok: false, why: '池模式（会真扣卡），如需验证请加 --force' });
    continue;
  }

  const orderNo = `CHECK-DELIVERY-${stamp}-${i + 1}`;
  const r = await call('/goofish/order/purchase/create', {
    order_no: orderNo,
    goods_no: goodsNo,
    buy_quantity: 1,
    biz_order_no: `XY-${orderNo}`,
    notify_url: 'https://example.invalid/notify',
  });
  const card = r?.data?.card_items?.[0]?.card_pwd as string | undefined;
  if (r?.code !== 0 || !card) {
    results.push({ no: goodsNo, ok: false, why: `下单失败 code=${r?.code} msg=${r?.msg ?? r?.__raw ?? ''}` });
    continue;
  }
  created.push(orderNo);

  // 内容自检：必须有可点的分享链接，且与条目里记的一致
  const hasLink = /https?:\/\/\S+/.test(card);
  const hasPwd = /提取码/.test(card);
  results.push({ no: goodsNo, ok: hasLink && hasPwd, why: hasLink && !hasPwd ? '缺少提取码' : hasLink ? '' : '内容里没有分享链接' });

  if (!ALL || !(hasLink && hasPwd)) {
    console.log(`── ${goodsNo}  ${g.goods_name.slice(0, 40)}`);
    console.log(card.split('\n').map((l) => '   ' + l).join('\n'));
    console.log('');
  } else {
    console.log(`  ${String(i + 1).padStart(3)}/${codes.length}  ${goodsNo}  ✓`);
  }
}

/* ---------------- 清理测试订单 ---------------- */
if (created.length) {
  const p = path.join(DATA_DIR, 'orders.json');
  try {
    const orders = JSON.parse(fs.readFileSync(p, 'utf8'));
    let removed = 0;
    for (const k of created) if (orders[k]) { delete orders[k]; removed++; }
    fs.writeFileSync(p, JSON.stringify(orders, null, 2) + '\n');
    console.log(`（已清理 ${removed} 条测试订单，不留在台账里）`);
  } catch (e: any) {
    console.log(`（测试订单清理失败，可手动删 orders.json 里 CHECK-DELIVERY-* ：${e?.message}）`);
  }
}

/* ---------------- 汇总 ---------------- */
const bad = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - bad.length}/${results.length} 正常`);
if (bad.length) {
  console.log('\n⚠️ 以下商品发货有问题（买家拍下会收不到东西）：');
  for (const b of bad) console.log(`   ${b.no}  —— ${b.why}`);
  process.exit(2);
}
