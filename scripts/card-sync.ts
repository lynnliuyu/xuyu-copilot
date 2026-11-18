#!/usr/bin/env node
/**
 * 发货闭环：把「资源条目的网盘分享链接」灌进网关的**卡密池**。
 *
 * 为什么必须有这一步：
 *   资源条目（drafts/.resources.json）和商品草稿（drafts/*.json）都只是**我们本地**的文件，
 *   闲管家读不到。买家拍下后，管家回调我们的网关 `/goofish/order/purchase/create`，
 *   网关只会去查 `packages/xgj-gateway/data/cards.json`。
 *   不灌进去，就是这个结果：**商品上架了、有人买了、发不出货**。
 *
 * 用法：
 *   npx tsx scripts/card-sync.ts                同步「已上架」商品的发货内容
 *   npx tsx scripts/card-sync.ts --all          连未上架的一起同步（便于提前配货源）
 *   npx tsx scripts/card-sync.ts --dry          只打印将要写入的内容
 *
 * 幂等：
 *   · 商品已存在 → 只更新时间戳，不重复插入
 *   · 卡密已是 used → **绝不覆盖**（那是已经发给买家的内容）
 *   · 卡密内容有变化 → 覆盖共享卡的第一条（共享模式只用第一条）
 *
 * ⚠️ 写的是 packages/xgj-gateway/data/（compose 的挂载卷），
 *    网关每次请求都重新读文件，所以**改完不需要重启网关**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCatalog,
  saveCatalog,
  cardPool,
  saveCardPool,
  dataDir,
  type CardRecord,
} from '../packages/xgj-gateway/src/store';
import { GOODS_STATUS } from '../packages/xgj-gateway/src/types';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRAFTS = path.join(PROJ, 'drafts');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const ALL = argv.includes('--all');

/* ---------------- 读本地数据 ---------------- */
const resources: Record<string, any> = JSON.parse(fs.readFileSync(path.join(DRAFTS, '.resources.json'), 'utf8'));
let listings: Record<string, any> = {};
try {
  listings = JSON.parse(fs.readFileSync(path.join(DRAFTS, '.listings.json'), 'utf8'));
} catch { /* 还没发布过 */ }

/**
 * 生成发给买家的发货内容（买家在闲鱼订单页看到的就是这一段）。
 * 两侧都有就给两个（任选其一），只有一侧就给那一个 —— 与商品描述里的说法保持一致。
 */
function deliveryText(title: string, sides: Array<{ label: string; url: string; pwd: string }>): string {
  const lines = [
    `【${title}】`,
    '',
    sides.length > 1
      ? '■ 下载（两种网盘任选其一，内容一致；请先转存到你自己的网盘再下载）'
      : '■ 下载（请先转存到你自己的网盘再下载，避免链接失效）',
  ];
  for (const s of sides) {
    lines.push(`· ${s.label}：${s.url}`);
    if (s.pwd) lines.push(`  提取码：${s.pwd}`);
  }
  lines.push(
    '',
    '■ 说明',
    '· 请先转存到你自己的网盘，避免链接失效',
    '· 若遇链接失效，凭订单找我补发',
    '· 虚拟商品，发出后不支持退款，介意勿拍',
  );
  return lines.join('\n');
}

/* ---------------- 组装待同步清单 ---------------- */
const targets: Array<{
  goods_no: string;
  title: string;
  price: number;
  sides: Array<{ label: string; url: string; pwd: string }>;
}> = [];
for (const [id, r] of Object.entries(resources)) {
  const code = r.draft_code || `BD-${id.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}`;
  const listing = listings[code];
  if (!ALL && !listing) continue; // 默认只同步已上架的

  // 百度优先，其次夸克；都有就都给（与商品描述口径一致）
  const sides = [
    { label: '百度网盘', url: r.baidu?.share_url?.trim() ?? '', pwd: r.baidu?.pwd ?? '' },
    { label: '夸克网盘', url: r.quark?.share_url?.trim() ?? '', pwd: r.quark?.pwd ?? '' },
  ].filter((s) => s.url);
  if (!sides.length) continue; // 没有任何发货链接，跳过后会在统计里体现

  // 标题优先取草稿里实际发布用的那个
  let title = r.display_name || r.name || id;
  try {
    const draftFile = path.join(DRAFTS, `${code}.json`);
    if (fs.existsSync(draftFile)) {
      const d = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
      title = d.publish_shop?.[0]?.title || title;
    }
  } catch { /* 草稿坏了就用资源名兜底 */ }

  targets.push({
    goods_no: code,
    title,
    price: r.price_fen && r.price_fen > 0 ? r.price_fen : 990,
    sides,
  });
}
targets.sort((a, b) => a.goods_no.localeCompare(b.goods_no));

/* ---------------- 预览 ---------------- */
console.log(`数据目录 ${dataDir()}`);
console.log(`待同步 ${targets.length} 个商品（${ALL ? '含未上架' : '仅已上架'}）${DRY ? '　【dry-run】' : ''}\n`);
for (const t of targets.slice(0, 5)) {
  console.log(`  ${t.goods_no}  ¥${(t.price / 100).toFixed(2)}  ${t.title.slice(0, 34)}`);
  console.log(`      ${t.sides.map((s) => `${s.label} ${s.url}`).join('  |  ')}`);
}
if (targets.length > 5) console.log(`  …其余 ${targets.length - 5} 个`);

if (DRY) {
  console.log('\n（dry-run，未写入任何文件）');
  process.exit(0);
}

/* ---------------- 写入 ---------------- */
const catalog = loadCatalog();
const cards = cardPool();
const now = Math.floor(Date.now() / 1000);

let goodsAdded = 0, goodsTouched = 0, cardAdded = 0, cardUpdated = 0, cardSkipped = 0;

for (const t of targets) {
  /* 1) 货源商品条目（管家在「卡密仓库」里挑的就是它） */
  const g = catalog.goods.find((x) => x.goods_no === t.goods_no);
  if (!g) {
    catalog.goods.push({
      goods_no: t.goods_no,
      goods_type: 1, // 卡密类（闲管家查询时传 1，传 2 会被过滤掉 → 关联商品下拉框空白）
      goods_name: t.title,
      price: t.price,
      stock: 9999,
      status: GOODS_STATUS.ON,
      update_time: now,
      stock_mode: 'shared', // 一链多发：同一条链接可无限次发给不同买家
      shared_stock: 9999,
    });
    goodsAdded++;
  } else {
    // 只同步会变的字段，别覆盖人工在后台改过的东西
    g.goods_name = t.title;
    g.price = t.price;
    g.update_time = now;
    g.stock_mode = g.stock_mode ?? 'shared';
    g.shared_stock = g.shared_stock ?? 9999;
    if (g.status !== GOODS_STATUS.OFF) g.status = GOODS_STATUS.ON;
    goodsTouched++;
  }

  /* 2) 卡密内容 */
  const text = deliveryText(t.title, t.sides);
  const pool: CardRecord[] = cards[t.goods_no] ?? [];
  const shared = pool[0];
  if (!pool.length) {
    cards[t.goods_no] = [{ card_pwd: text, used: false }];
    cardAdded++;
  } else if (shared.used) {
    // ⚠️ 已经发出去过的内容不动，避免"改卡"影响已成交订单的售后口径
    cardSkipped++;
  } else if (shared.card_pwd !== text) {
    shared.card_pwd = text;
    cardUpdated++;
  }
}

saveCatalog(catalog);
saveCardPool(cards);

console.log(`\n货源商品：新增 ${goodsAdded} · 更新 ${goodsTouched}`);
console.log(`卡密内容：新增 ${cardAdded} · 更新 ${cardUpdated} · 跳过（已发出） ${cardSkipped}`);
console.log(`\n现在 catalog 共 ${catalog.goods.length} 个货源商品，cards 共 ${Object.keys(cards).length} 个键`);
console.log('下一步（人工，官方流程如此）：闲管家后台 →「卡密仓库」→ 为每个闲鱼商品选中上面的货源商品并关联。');
