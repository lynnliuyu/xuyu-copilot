#!/usr/bin/env node
/**
 * 卡密发货「一条龙」：建卡种 → 灌卡密 → 绑商品，全自动，不用在后台点。
 *
 * 为什么能做：2026-10-19 用隔离测试卡种实测出 `kami/kind/edit` 接受
 *   `app_id`(number) + `goods_no`(string) —— 就是后台那个「关联商品」。
 *   ⚠️ app_id 填 0 时 goods_no 会被静默丢弃；服务端也不校验商品是否存在。
 *
 * 数据来源：
 *   · 台账 `drafts/.listings.json` —— code → { product_id, title, item_id }
 *   · 卡密   `packages/xgj-gateway/data/cards.json` —— code → [{ card_pwd, used }]
 *
 * 用法：
 *   npx tsx scripts/kami-auto.ts --codes BD-GFX-124840 --dry     预演（默认）
 *   npx tsx scripts/kami-auto.ts --codes BD-GFX-124840 --apply   真写
 *   npx tsx scripts/kami-auto.ts --hot --dry                     近 90 天出过单的商品
 *   npx tsx scripts/kami-auto.ts --all --dry                     卡密池全部（758，慎用）
 *   npx tsx scripts/kami-auto.ts --rollback                      解绑并删除本脚本建的卡种
 *
 * 幂等：同名卡种复用；已有库存不重复灌；已绑定同编号直接跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listKamiKinds,
  createKamiKind,
  addKamiStock,
  deleteKamiKind,
  bindKamiKindToGoods,
  unbindKamiKind,
  listOrders,
} from '../packages/goofish-adapter/src/api';
import { appIdFromEnv } from '../packages/goofish-adapter/src/config';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'out', 'kami-auto-state.json');
const LISTINGS = path.join(ROOT, 'drafts', '.listings.json');
const CARDS = path.join(ROOT, 'packages', 'xgj-gateway', 'data', 'cards.json');

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string, d?: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : d;
};

const APPLY = has('--apply');
const ROLLBACK = has('--rollback');
const PER_CODE = Math.max(1, Number(val('--per-code', '999')));

const C = {
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

interface Listing {
  product_id?: number;
  title?: string;
  item_id?: number;
  state?: string;
}
type CardRow = { card_pwd?: string; card_no?: string; used?: boolean };

const loadJson = <T>(p: string, fb: T): T => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return fb;
  }
};
const saveState = (d: Record<string, unknown>) =>
  fs.writeFileSync(STATE, JSON.stringify(d, null, 2), 'utf8');

async function resolveCodes(): Promise<string[]> {
  const codesArg = val('--codes');
  if (codesArg) return codesArg.split(',').map((s) => s.trim()).filter(Boolean);

  const codesFile = val('--codes-file');
  if (codesFile) {
    const p = path.isAbsolute(codesFile) ? codesFile : path.join(ROOT, codesFile);
    return JSON.parse(fs.readFileSync(p, 'utf8')) as string[];
  }

  const cards = loadJson<Record<string, CardRow[]>>(CARDS, {});
  if (has('--all')) return Object.keys(cards);

  if (has('--hot')) {
    const listings = loadJson<Record<string, Listing>>(LISTINGS, {});
    const byPid = new Map<number, string>();
    for (const [code, v] of Object.entries(listings)) {
      if (v.product_id) byPid.set(Number(v.product_id), code);
    }
    const seen = new Set<string>();
    for (let page = 1; page <= 20; page++) {
      const r = await listOrders({ page_no: page, page_size: 50 });
      const list = r.list ?? [];
      let fresh = 0;
      for (const o of list) {
        const code = byPid.get(Number(o.goods?.product_id));
        if (code && cards[code] && !seen.has(code)) {
          seen.add(code);
          fresh++;
        }
      }
      if (list.length < 50 || fresh === 0) break;
    }
    return [...seen];
  }

  return [];
}

/**
 * 卡密池里的一条 → 闲管家要求的 `{card_no, card_pwd}` 两段。
 *
 * ⚠️ 2026-10-19 实测：整段多行文案（约 220 字）灌进去会报
 *   `code=100001 … 卡密长度超过限制`。所以必须拆成
 *   卡号=下载链接、密码=提取码（各几十字符），说明文字不进卡密。
 */
function cardParts(code: string, rows: CardRow[]): { card_no: string; card_pwd: string } | null {
  const first = rows.find((r) => r.card_pwd && String(r.card_pwd).trim());
  if (!first) return null;
  const txt = String(first.card_pwd).trim();

  const links = [...txt.matchAll(/https?:\/\/[^\s，。、）)】]+/g)].map((m) => m[0]);
  const pwds = [...txt.matchAll(/(?:提取码|密码)[:：]\s*([A-Za-z0-9]{2,12})/g)].map((m) => m[1]);

  if (links.length > 0) {
    return {
      card_no: links.join('  '),
      card_pwd: pwds.length > 0 ? pwds.join(' / ') : '无',
    };
  }
  // 不是链接型卡密：按「卡号 / 密码」原样拆
  const no = String(first.card_no ?? '').trim();
  if (no) return { card_no: no, card_pwd: txt };
  return { card_no: txt.slice(0, 120), card_pwd: txt.slice(120, 240) || '无' };
}

async function main() {
  const codes = await resolveCodes();
  const listings = loadJson<Record<string, Listing>>(LISTINGS, {});
  const cards = loadJson<Record<string, CardRow[]>>(CARDS, {});
  const state = loadJson<Record<string, { kind_id: number; code: string; at: string }>>(STATE, {});
  const kinds = await listKamiKinds();

  if (ROLLBACK) {
    const entries = Object.entries(state);
    console.log(C.b(`回滚 ${entries.length} 个卡种`));
    for (const [code, v] of entries) {
      try {
        await unbindKamiKind(v.kind_id).catch(() => undefined);
        await deleteKamiKind({ kind_id: v.kind_id });
        delete state[code];
        console.log(`  ${C.g('✅')} ${code} kind_id=${v.kind_id}`);
      } catch (e: unknown) {
        console.log(`  ${C.r('❌')} ${code} ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    saveState(state);
    return;
  }

  if (codes.length === 0) {
    console.log('未指定范围。用 --codes A,B 或 --hot 或 --all');
    return;
  }

  console.log(C.b(`\n卡密一条龙　范围 ${codes.length} 个商品　模式 ${APPLY ? '真实写入' : '预演'}`));
  console.log(C.dim(`应用 ID ${appIdFromEnv()}　每个卡种灌 ${PER_CODE} 条\n`));

  const byGoods = new Map<string, (typeof kinds)[number]>();
  for (const k of kinds) {
    if (k.goods_no) byGoods.set(String(k.goods_no), k);
  }

  let built = 0;
  let bound = 0;
  let skipped = 0;
  let failed = 0;

  for (const code of codes) {
    const row = listings[code];
    const rows = cards[code];
    const parts = cardParts(code, rows ?? []);
    const title = String(row?.title ?? code).slice(0, 40);

    console.log(`── ${C.b(code)}　${title}`);

    if (!row) {
      console.log(`   ${C.r('✗ 台账里没有该编号')} → 跳过（宁可不绑，也别绑错）`);
      failed++;
      continue;
    }
    if (!parts) {
      console.log(`   ${C.y('⚠ 卡密池没有这个商品的链接')} → 只建卡种不灌卡`);
    }

    const existing = byGoods.get(code);
    if (existing?.kind_id) {
      console.log(`   ${C.g('✓ 已绑定')} kind_id=${existing.kind_id} 库存=${existing.stock}`);
      skipped++;
      continue;
    }

    // 找一个同名但还没被占用的卡种来复用
    const reusable = kinds.find(
      (k) => String(k.kind_name ?? '') === title && !k.goods_no,
    );

    if (!APPLY) {
      console.log(
        reusable
          ? `   → 复用卡种 kind_id=${reusable.kind_id}（库存 ${reusable.stock ?? 0}）`
          : `   → 新建卡种「${title}」`,
      );
      if (parts) console.log(`   → 灌 ${PER_CODE} 条：${parts.card_no.slice(0, 46)} / ${parts.card_pwd}`);
      console.log(`   → 绑 goods_no=${code} app_id=${appIdFromEnv()}`);
      continue;
    }

    try {
      let kindId = Number(reusable?.kind_id ?? 0);
      if (!kindId) {
        const created = await createKamiKind({
          kind_name: title,
          kind_alias: '',
          kind_category: 0,
          kind_type: 1,
          card_type: 1,
          pwd_type: 1,
          card_prefix: '',
          pwd_prefix: '',
          separator: 0,
          stock_warning: 20,
          sort: 1,
        } as never);
        kindId = Number(created.kind_id);
        built++;
        console.log(`   ${C.g('✓ 卡种已建')} kind_id=${kindId}`);
      } else {
        console.log(`   ${C.dim('复用卡种')} kind_id=${kindId}`);
      }

      state[code] = { kind_id: kindId, code, at: new Date().toISOString() };
      saveState(state);

      if (parts && Number(reusable?.stock ?? 0) === 0) {
        await addKamiStock({
          kind_id: kindId,
          cards: Array.from({ length: PER_CODE }, () => ({ card_no: parts.card_no, card_pwd: parts.card_pwd })),
          is_repeat: true,
          is_priority: true,
          is_cover: false,
          cost: 1,
        } as never);
        console.log(`   ${C.g('✓ 已灌')} ${PER_CODE} 条卡密`);
      }

      const r = await bindKamiKindToGoods({ kind_id: kindId, goods_no: code, goods_name: title });
      bound++;
      console.log(`   ${C.g('✓ 已绑定并核对')} ${r.goods_no}`);
      await new Promise((res) => setTimeout(res, 300));
    } catch (e: unknown) {
      failed++;
      console.log(`   ${C.r('✗')} ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(
    `\n${C.b('汇总')}　新建 ${built}　绑定 ${bound}　已存在 ${skipped}　失败 ${failed}`,
  );
  if (!APPLY) console.log(C.y('（预演，未写入。加 --apply 生效）'));
  else console.log(C.dim(`状态已记录 ${STATE}，回滚用 --rollback`));
}

void main().catch((e) => {
  console.error(`\n💥 ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
