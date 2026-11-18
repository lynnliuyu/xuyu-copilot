#!/usr/bin/env node
/**
 * 走「进销存 卡密 API」链路，为 ArtCraft 14 个商品预建卡种 + 灌卡密库存。
 *
 * 背景（2026-10-15）：用户明确选择「走卡密 API 链路」（而非自建网关发货）。
 *   参考用户现有做法：6 个 workbuddy 卡种 = kind_type 1（文本卡密）+ 本地卡密库存。
 *
 * ⚠️ 字段要求（官方文档没写全，以下全是实测出来的，别再踩）：
 *   · `kami/kind/delete` 的 `kind_id` 必须是**字符串数组** `["1800..."]`
 *     （传数字/字符串都报 `cannot unmarshal number into Go value of type []interface {}`）；
 *   · `kami/storage/create` 的 `cards` 必须是**对象数组**，元素字段 `card_no` + `card_pwd`
 *     （缺了报 `field "cards[N].xxx" is not set`）；
 *   · `cost`（成本单价）**不能为 0**，传 0 报「成本单价不能为0」；
 *   · `is_repeat` / `is_priority` / `is_cover` 必须是**布尔**；
 *   · `kind_type=2` 的 `card_pwd` 被要求是**图片链接** → 网盘链接场景必须用
 *     `kind_type=1`（文本卡密），与用户现有 workbuddy 卡种一致。
 *
 * ⚠️ 边界（务必记住）：官方 46 个接口里**没有**「把卡种挂到具体闲鱼商品」的端点。
 *    灌完卡密后，仍需人工在 闲管家后台 →「发货」→ 关联商品 里逐个绑定。
 *
 * 用法：
 *   npx tsx scripts/artcraft-kami.ts --dry             预演（默认，不写入）
 *   npx tsx scripts/artcraft-kami.ts --apply           真正创建（幂等：同名卡种跳过）
 *   npx tsx scripts/artcraft-kami.ts --apply --stock 300
 *   npx tsx scripts/artcraft-kami.ts --apply --only BD-ARTCRAFT
 *   npx tsx scripts/artcraft-kami.ts --rollback        删除本脚本创建的全部卡种
 *
 * 需要 GOOFISH_LIVE=true（防误触生产）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listKamiKinds, createKamiKind, addKamiStock, deleteKamiKind,
} from '../packages/goofish-adapter/src/api';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'out', 'artcraft-kami-kinds.json');

const CODES = [
  'BD-ARTCRAFT', 'BD-PHOTOCRAFT', 'BD-PDFCRAFT', 'BD-LIGHTCRAFT', 'BD-WORDCRAFT',
  'BD-VECTORCRAFT', 'BD-EFFECTCRAFT', 'BD-CADCRAFT', 'BD-DESIGNCRAFT', 'BD-DECKCRAFT',
  'BD-SOUNDCRAFT', 'BD-FIGCRAFT', 'BD-CRAFT-LAUNCHER', 'BD-ARTCRAFT-FULLSET',
];

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string, d: any) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const APPLY = has('--apply');
const ROLLBACK = has('--rollback');
const STOCK = Math.max(1, Number(val('--stock', 999)));
const COST = Math.max(1, Number(val('--cost', 1)));   // 成本单价（分），平台不接受 0
const KIND_TYPE = Number(val('--kind-type', 1));      // 1 = 文本卡密（已验证可用）
const DRY = !APPLY && !ROLLBACK;
const ONLY: string[] = [];
argv.forEach((a, i) => { if (a === '--only' && argv[i + 1]) ONLY.push(argv[i + 1].toUpperCase()); });

const log = (s = '') => console.log(s);
const loadState = (): Record<string, any> => {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
};
const saveState = (d: Record<string, any>) => fs.writeFileSync(STATE, JSON.stringify(d, null, 2));

/** 灌卡密（失败不抛，只记日志） */
async function fill(kind_id: number, p: any, state: Record<string, any>) {
  try {
    const cards = Array.from({ length: STOCK }, () => ({ card_no: p.card_no, card_pwd: p.card_pwd }));
    await addKamiStock({
      kind_id, cards, is_repeat: true, cost: COST, is_priority: true, is_cover: false,
    } as any);
    log(`      ✅ 已灌 ${STOCK} 条卡密`);
    state[p.code] = { kind_id, name: p.name, stock: STOCK, at: new Date().toISOString() };
    saveState(state);
  } catch (e: any) {
    log(`      ❌ 灌卡密失败：${String(e?.message ?? e).slice(0, 220)}`);
  }
}

async function main() {
  const res: Record<string, any> = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'drafts', '.resources.json'), 'utf8'),
  );
  const state = loadState();

  if (ROLLBACK) {
    const ids = Object.entries(state).filter(([, v]) => v?.kind_id);
    log(`════ 回滚：删除 ${ids.length} 个卡种 ════`);
    for (const [code, v] of ids) {
      try {
        await deleteKamiKind({ kind_id: v.kind_id });
        log(`  ✅ 已删除 ${code} kind_id=${v.kind_id}`);
        delete state[code];
      } catch (e: any) {
        log(`  ❌ ${code} kind_id=${v.kind_id} 删除失败：${String(e?.message ?? e).slice(0, 160)}`);
      }
    }
    saveState(state);
    return;
  }

  const existing = await listKamiKinds();
  const byName = new Map(existing.map((k: any) => [String(k.kind_name), k]));

  log(`════ ArtCraft 卡种预建（stock=${STOCK}, cost=${COST}, kind_type=${KIND_TYPE}）════`);
  log(`模式：${DRY ? '预演（不写入）' : '真实写入'}`);
  log();

  const plan = (ONLY.length ? CODES.filter((c) => ONLY.includes(c)) : CODES).map((code) => {
    const rid = code.slice(3).toLowerCase();
    const r = res[rid] ?? {};
    const b = r.baidu ?? {};
    const q = r.quark ?? {};
    const noParts: string[] = [];
    const pwds: string[] = [];
    if (b.share_url) { noParts.push(`百度网盘 ${b.share_url}`); if (b.pwd) pwds.push(b.pwd); }
    if (q.share_url) { noParts.push(`夸克网盘 ${q.share_url}`); if (q.pwd) pwds.push(q.pwd); }
    return {
      code,
      name: String(r.display_name ?? code).replace(/^ArtCraft AI创作工作台$/, 'ArtCraft 开源创作工作台'),
      card_no: noParts.join('　｜　'),
      card_pwd: pwds.join(' / '),
    };
  });

  for (const p of plan) {
    log(`── ${p.code}  ${p.name}`);
    log(`   下载链接：${p.card_no.slice(0, 110)}`);
    log(`   提取码：${p.card_pwd || '(无)'}`);

    if (!p.card_no) { log('   ⚠️ 该资源没有网盘链接 → 跳过'); continue; }

    const hit = byName.get(p.name) as any;
    if (hit) {
      const st = Number(hit.stock ?? 0);
      log(`   ⏭  卡种已存在（kind_id=${hit.kind_id}，库存=${st}）`);
      if (st > 0) { log('      库存已就绪 → 跳过'); continue; }
      if (DRY) { log('      库存为 0 → 会灌卡密（预演）'); continue; }
      state[p.code] = { ...(state[p.code] ?? {}), kind_id: hit.kind_id, name: p.name };
      saveState(state);
      await fill(hit.kind_id, p, state);
      continue;
    }

    if (DRY) { log(`   → 将建卡种「${p.name}」+ 灌 ${STOCK} 条卡密（预演）`); continue; }

    try {
      const { kind_id } = await createKamiKind({
        kind_name: p.name,
        kind_alias: '',
        kind_category: 0,
        kind_type: KIND_TYPE,
        card_type: 1,
        pwd_type: 1,
        card_prefix: '下载链接：',
        pwd_prefix: '提取码：',
        separator: 0,
        stock_warning: 20,
        sort: 1,
      } as any);
      log(`   ✅ 卡种已建 kind_id=${kind_id}`);
      state[p.code] = { kind_id, name: p.name };
      saveState(state);
      await fill(kind_id, p, state);
    } catch (e: any) {
      log(`   ❌ 建卡种失败：${String(e?.message ?? e).slice(0, 220)}`);
    }
  }

  log();
  log('════ 结束 ════');
  if (DRY) log('（预演，未写入任何数据；加 --apply 真正创建）');
  else log(`已记录到 ${STATE}；回滚用 --rollback`);
  log('⚠️ 最后一步仍需人工：闲管家后台 →「发货」→ 关联商品，把每个闲鱼商品绑到对应卡种。');
}

main().catch((e) => { console.error('💥', e); process.exit(1); });
