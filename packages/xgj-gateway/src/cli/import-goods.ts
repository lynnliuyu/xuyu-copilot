/**
 * 把「商品定义 + 卡密池」导入网关数据目录。
 *
 * 输入文件格式（示例见 drafts/goods-bd-to-xy.json）：
 * {
 *   "merchant": { "mch_id": "bd-to-xy", "name": "…", "balance": 99999900 },
 *   "goods": [{
 *     "goods_no": "BD-IDB-001",
 *     "goods_type": 2,
 *     "goods_name": "…",
 *     "price": 990,                     // 单位：分
 *     "status": 1,                      // 1 在架 / 2 下架
 *     "cards": ["链接 + 提取码 + 说明", "…"]   // 每条 = 一份可交付内容
 *   }]
 * }
 *
 * 用法：
 *   npm run gw:import                                   # 预览（默认 dry-run）
 *   npm run gw:import -- --file x.json --apply
 *   npm run gw:import -- --apply --merge                # 只追加新商品/新卡密，不动已用状态
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, saveCatalog, cardPool, dataDir, ensureSeed, availableStock } from '../store';
import type { CardRecord } from '../store';
import { GOODS_STATUS, GOODS_TYPE, type Goods } from '../types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

interface InputGoods extends Partial<Goods> {
  goods_no: string;
  goods_name: string;
  price: number;
  cards?: string[];
}

interface InputFile {
  merchant?: { mch_id?: string; name?: string; balance?: number };
  goods: InputGoods[];
}

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const merge = argv.includes('--merge');
const fileArg = argv.indexOf('--file');
const file = fileArg >= 0 ? argv[fileArg + 1] : path.join(ROOT, 'drafts', 'goods-bd-to-xy.json');

const C = {
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  d: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

if (!fs.existsSync(file)) {
  console.error(`${C.r('❌ 找不到输入文件')}：${file}`);
  console.error('   可以先复制 drafts/goods-bd-to-xy.json 再改。');
  process.exit(2);
}

const input: InputFile = JSON.parse(fs.readFileSync(file, 'utf8'));
const problems: string[] = [];

if (!Array.isArray(input.goods) || input.goods.length === 0) problems.push('goods 必须是非空数组');

for (const [i, g] of (input.goods ?? []).entries()) {
  const at = `goods[${i}](${g.goods_no || '?'})`;
  if (!g.goods_no) problems.push(`${at} 缺少 goods_no`);
  if (!g.goods_name) problems.push(`${at} 缺少 goods_name`);
  if (!Number.isInteger(g.price) || g.price <= 0) problems.push(`${at} price 必须是 >0 的整数（单位：分）`);
  if (!g.cards || g.cards.length === 0) problems.push(`${at} 未提供 cards，导入后该商品可售库存为 0`);
  if (g.goods_type !== undefined && ![1, 2, 3].includes(g.goods_type)) problems.push(`${at} goods_type 只能是 1/2/3`);
  if (g.stock_mode !== undefined && !['pool', 'shared'].includes(g.stock_mode))
    problems.push(`${at} stock_mode 只能是 pool 或 shared`);
  for (const [j, c] of (g.cards ?? []).entries()) {
    if (typeof c !== 'string' || !c.trim()) problems.push(`${at} cards[${j}] 为空`);
  }
}

const mchIdEnv = process.env.XGJ_MCH_ID || '';
const mchIdFile = input.merchant?.mch_id || '';
if (mchIdEnv && mchIdFile && mchIdEnv !== mchIdFile) {
  problems.push(
    `merchant.mch_id(${mchIdFile}) 与 .env 的 XGJ_MCH_ID(${mchIdEnv}) 不一致 —— ` +
      '闲管家会用 .env 里的值验签，写错会导致线上 1000 商户不存在',
  );
}

console.log('');
console.log(C.b('=== 导入货源商品到网关 ==='));
console.log(`  模式      : ${apply ? C.y('APPLY（真实写入）') : 'DRY-RUN（预览，不写盘）'}${merge ? '  + merge' : ''}`);
console.log(`  输入文件  : ${file}`);
console.log(`  数据目录  : ${dataDir()}`);
console.log('');

if (problems.length) {
  console.log(C.y('  校验发现以下问题：'));
  for (const p of problems) console.log(`    ${C.r('·')} ${p}`);
  console.log('');
  if (apply) {
    console.error(C.r('  ❌ 存在校验问题，已中止写入。'));
    process.exit(1);
  }
  console.log(C.d('  （dry-run 继续渲染计划；加 --apply 时会因上述问题中止）'));
  console.log('');
}

// ---------------------------------------------------------------- 渲染计划

const existingCatalog = loadCatalog();
const existingCards = cardPool();
const existingGoodsNos = new Set(existingCatalog.goods.map((g) => g.goods_no));

const now = Math.floor(Date.now() / 1000);

/** 计算某商品本次会新增多少条卡密（merge 时按内容去重） */
function planCards(g: InputGoods): { add: number; skipped: number; oldFree: number } {
  const oldPool = existingCards[g.goods_no] ?? [];
  const oldFree = oldPool.filter((c) => !c.used).length;
  const incoming = g.cards ?? [];
  if (!merge) return { add: incoming.length, skipped: 0, oldFree };
  const known = new Set(oldPool.map((c) => c.card_pwd));
  const fresh = incoming.filter((c) => !known.has(c));
  return { add: fresh.length, skipped: incoming.length - fresh.length, oldFree };
}

let addGoods = 0;
let updGoods = 0;
let addCards = 0;
let skippedCards = 0;

console.log(C.b('  商品明细'));
for (const [i, g] of input.goods.entries()) {
  const isNew = !existingGoodsNos.has(g.goods_no);
  const { add, skipped, oldFree } = planCards(g);
  if (isNew) addGoods++;
  else updGoods++;
  addCards += add;
  skippedCards += skipped;

  const mode = g.stock_mode ?? 'pool';
  const modeLabel = mode === 'shared' ? C.y('共享链接(一链多发)') : C.g('卡密池(一单一链)');
  console.log(`    ${String(i + 1).padStart(2)}. ${isNew ? C.g('[新增]') : C.y('[覆盖]')} ${g.goods_no}  ${g.goods_name}`);
  console.log(
    C.d(
      `        ¥${(g.price / 100).toFixed(2)}  类型=${g.goods_type ?? GOODS_TYPE.CARD}  状态=${g.status ?? GOODS_STATUS.ON}  库存模式=${modeLabel}`,
    ),
  );
  console.log(
    C.d(
      mode === 'shared'
        ? `        持有内容 ${(g.cards ?? []).length} 条，对外显示库存 ${g.shared_stock ?? 9999}（同一条内容发给所有买家，不消耗）`
        : `        现有可售 ${oldFree}  →  本次入库 ${add} 条` + (skipped ? `（按内容去重跳过 ${skipped} 条）` : ''),
    ),
  );
}

console.log('');
console.log(C.b('  汇总'));
console.log(`    新增商品 ${addGoods} / 覆盖商品 ${updGoods}`);
console.log(`    写入卡密 ${addCards} 条${skippedCards ? `（去重跳过 ${skippedCards} 条）` : ''}`);
if (input.merchant?.balance !== undefined) console.log(`    商户余额 → ${input.merchant.balance} 分`);
console.log('');

if (!apply) {
  console.log(C.d('  这是预览。确认无误后加 --apply 真正写入。'));
  console.log('');
  process.exit(0);
}

// ---------------------------------------------------------------- 真实写入

ensureSeed();

const catalog = loadCatalog();
if (input.merchant?.balance !== undefined) catalog.merchant.balance = Number(input.merchant.balance);
if (input.merchant?.name) catalog.merchant.name = input.merchant.name;
if (input.merchant?.mch_id) catalog.merchant.mch_id = input.merchant.mch_id;

for (const g of input.goods) {
  const shared = g.stock_mode === 'shared';
  const entry: Goods = {
    goods_no: g.goods_no,
    goods_type: g.goods_type ?? GOODS_TYPE.CARD,
    goods_name: g.goods_name,
    price: g.price,
    stock: shared ? (g.shared_stock ?? 9999) : (g.cards ?? []).length,
    status: g.status ?? GOODS_STATUS.ON,
    update_time: now,
  };
  if (g.stock_mode) entry.stock_mode = g.stock_mode;
  if (g.shared_stock !== undefined) entry.shared_stock = g.shared_stock;
  const idx = catalog.goods.findIndex((x) => x.goods_no === g.goods_no);
  if (idx >= 0) catalog.goods[idx] = entry;
  else catalog.goods.push(entry);
}
saveCatalog(catalog);

const pool = cardPool();
for (const g of input.goods) {
  const existing = pool[g.goods_no] ?? [];
  const incoming = g.cards ?? [];
  if (merge) {
    // 只追加：已用状态原样保留，重复内容不入库
    const known = new Set(existing.map((c) => c.card_pwd));
    for (const c of incoming) {
      if (known.has(c)) continue;
      known.add(c);
      existing.push({ card_pwd: c, used: false } satisfies CardRecord);
    }
    pool[g.goods_no] = existing;
  } else {
    // 覆盖：**必须保留已出库记录**，否则等于把卖给过买家的卡再卖一次
    const used = existing.filter((c) => c.used);
    pool[g.goods_no] = [
      ...used,
      ...incoming.map((c) => ({ card_pwd: c, used: false }) satisfies CardRecord),
    ];
  }
}

fs.mkdirSync(dataDir(), { recursive: true });
fs.writeFileSync(path.join(dataDir(), 'cards.json'), JSON.stringify(pool, null, 2), 'utf8');

console.log(C.g('  ✅ 已写入。'));
console.log('');
for (const g of input.goods) {
  console.log(`    ${g.goods_no}  当前可售 ${availableStock(g.goods_no)} 条`);
}
console.log('');
console.log(C.d('  提示：网关进程无需重启，数据在每次请求时读取。'));
console.log('');
