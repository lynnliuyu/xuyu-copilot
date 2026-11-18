#!/usr/bin/env node
/**
 * 把整本台账（drafts/.listings.json）刷成**闲管家线上的真实状态**。
 *
 * 为什么需要：2026-10-09 实测发现台账会**漂移** —— `BD-FIGMA`/`BD-PS2025` 台账里还写着
 * `on_sale`，实际 2026-10-08 16:01 就被平台下架了（`product_status=36 down_shelved`）。
 * 台账一漂，管理页就会骗人；而管理页的 state 是用来看「货还挂着没」的，这正是最不能错的地方。
 *
 * 只读：只调 `product/detail`，不碰发布、不占 300s 名额、不需要发布护栏。
 *
 * 用法：
 *   npm run sync:listings                 全量同步（默认每条间隔 350ms）
 *   npm run sync:listings -- --limit 20   先试 20 条
 *   npm run sync:listings -- --dry        只报告不写台账
 *   npm run sync:listings -- --delay=600  放慢（遇到限流时用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProduct } from '../packages/goofish-adapter/src/api';
import { listingStateFromRemoteStatus, describeListingState } from '../packages/goofish-adapter/src/state';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = path.join(ROOT, 'drafts', '.listings.json');
const OUT = path.join(ROOT, 'out');
const argv = process.argv.slice(2);
/** 同时支持 `--limit=20` 和 `--limit 20` 两种写法（之前只认前者，踩过） */
const flag = (n: string, d: number) => {
  const eq = argv.find((x) => x.startsWith(`--${n}=`));
  if (eq) return Number(eq.split('=')[1]);
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1]) return Number(argv[i + 1]);
  return d;
};
const DELAY = flag('delay', 350);
const LIMIT = flag('limit', 0);
const DRY = argv.includes('--dry');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ledger: Record<string, any> = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
const entries = Object.entries(ledger).filter(([, v]) => v?.product_id);
const todo = LIMIT > 0 ? entries.slice(0, LIMIT) : entries;

console.log(`台账 ${Object.keys(ledger).length} 条，其中有 product_id 的 ${entries.length} 条，本次同步 ${todo.length} 条`);
console.log(`间隔 ${DELAY}ms　预计 ${Math.ceil((todo.length * (DELAY + 260)) / 60000)} 分钟${DRY ? '　【dry-run】' : ''}\n`);

const changed: Array<{ code: string; from: string; to: string; product_status: number }> = [];
const errors: Array<{ code: string; error: string }> = [];
let same = 0;

for (let i = 0; i < todo.length; i++) {
  const [code, rec] = todo[i];
  try {
    const d: any = await getProduct(rec.product_id);
    const state = listingStateFromRemoteStatus(d?.product_status);
    if (state !== rec.state) {
      changed.push({ code, from: String(rec.state), to: state, product_status: Number(d?.product_status) });
      if (!DRY) {
        ledger[code] = {
          ...rec,
          state,
          updated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
        };
      }
    } else {
      same += 1;
    }
  } catch (e: any) {
    errors.push({ code, error: String(e?.message ?? e).slice(0, 120) });
  }
  if ((i + 1) % 25 === 0 || i === todo.length - 1) {
    process.stdout.write(`  进度 ${i + 1}/${todo.length}　变化 ${changed.length}　一致 ${same}　失败 ${errors.length}\r`);
  }
  await sleep(DELAY);
}

if (!DRY && changed.length) fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n', 'utf8');

const report = {
  at: new Date().toISOString(),
  checked: todo.length,
  changed: changed.length,
  same,
  errors: errors.length,
  changes: changed,
  error_samples: errors.slice(0, 20),
};
fs.mkdirSync(OUT, { recursive: true });
const rf = path.join(OUT, `listings-sync-${Date.now()}.json`);
fs.writeFileSync(rf, JSON.stringify(report, null, 2), 'utf8');

console.log('\n\n===== 同步结果 =====');
console.log(`检查 ${todo.length}　状态变化 ${changed.length}　本来就一致 ${same}　失败 ${errors.length}`);
const byTo: Record<string, number> = {};
for (const c of changed) byTo[`${c.from} → ${c.to}`] = (byTo[`${c.from} → ${c.to}`] || 0) + 1;
for (const [k, v] of Object.entries(byTo).sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(28)} ${v}`);
if (changed.length) {
  console.log('\n前 8 条变化：');
  for (const c of changed.slice(0, 8)) {
    const t = String(ledger[c.code]?.title ?? '').slice(0, 26);
    console.log(`   ${c.code.padEnd(20)} ${c.from} → ${describeListingState(c.to as any).padEnd(8)} ${t}`);
  }
}
if (errors.length) console.log(`\n失败样例：${errors.slice(0, 3).map((e) => `${e.code}: ${e.error}`).join(' | ')}`);
console.log(`\n明细：${path.relative(ROOT, rf)}${DRY ? '（dry-run，台账未改）' : ''}`);
