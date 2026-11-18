/**
 * 把卡种的「内容方式」设成 **货源采购**（priority_sale = 2）。
 *
 * 2026-10-19 实测枚举：
 *   1 = 卡密库存（默认，闲管家用自己灌的卡密）
 *   2 = **货源采购**（下单时去调关联的虚拟货源应用，也就是我们的 bd-to-xy 网关）
 *   3 / 0 → 无效，服务端回落成 1
 *
 * 这是「发货设置 → 内容方式 = 货源」的 API 版本。
 * 配合 `app_id=bd-to-xy` + `goods_no=商品编号` 才是完整配置。
 *
 * 用法：
 *   npx tsx scripts/kami-set-source-mode.ts --dry
 *   npx tsx scripts/kami-set-source-mode.ts --apply
 *   npx tsx scripts/kami-set-source-mode.ts --apply --codes BD-ARTCRAFT,BD-GFX-129863
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getKamiKind, editKamiKind } from '../packages/goofish-adapter/src/api';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'out', 'kami-auto-state.json');
const APPLY = process.argv.includes('--apply');
const codesIdx = process.argv.indexOf('--codes');
const ONLY =
  codesIdx >= 0 && process.argv[codesIdx + 1]
    ? new Set(process.argv[codesIdx + 1].split(',').map((s) => s.trim()))
    : null;

const C = {
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8')) as Record<
    string,
    { kind_id: number }
  >;
  let entries = Object.entries(state);
  if (ONLY) entries = entries.filter(([c]) => ONLY.has(c));

  console.log(C.b(`\n目标：priority_sale=2（货源采购）　范围 ${entries.length} 个卡种`));
  console.log(`模式：${APPLY ? '真实写入' : '预演'}\n`);

  let changed = 0;
  let already = 0;
  let failed = 0;

  for (const [code, v] of entries) {
    const id = Number(v.kind_id);
    try {
      const k = (await getKamiKind(id)) as never as Record<string, unknown>;
      if (Number(k.priority_sale) === 2) {
        already++;
        continue;
      }
      if (!APPLY) {
        changed++;
        if (changed <= 3) console.log(`  将设 ${code} kind_id=${id}（当前 ${k.priority_sale}）`);
        continue;
      }
      await editKamiKind({
        kind_id: id,
        kind_name: String(k.kind_name ?? ''),
        kind_alias: String(k.kind_alias ?? ''),
        kind_category: Number(k.kind_category ?? 0),
        kind_type: Number(k.kind_type ?? 1),
        card_type: Number(k.card_type ?? 1),
        pwd_type: Number(k.pwd_type ?? 1),
        card_prefix: String(k.card_prefix ?? ''),
        pwd_prefix: String(k.pwd_prefix ?? ''),
        separator: Number(k.separator ?? 0),
        stock_warning: Number(k.stock_warning ?? 20),
        sort: Number(k.sort ?? 1),
        cost: Number(k.cost ?? 0),
        app_id: Number(k.app_id ?? 0),
        goods_no: String(k.goods_no ?? ''),
        goods_name: String(k.goods_name ?? ''),
        priority_sale: 2,
      } as never);
      const after = (await getKamiKind(id)) as never as Record<string, unknown>;
      if (Number(after.priority_sale) === 2) {
        changed++;
        if (changed % 25 === 0) console.log(`  …已设 ${changed}`);
      } else {
        failed++;
        console.log(`  ${C.y('⚠')} ${code} 读回 ${after.priority_sale}，未生效`);
      }
    } catch (e: unknown) {
      failed++;
      console.log(`  ${C.r('✗')} ${code} ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    }
  }

  console.log(`\n${C.b('汇总')}　已设 ${changed}　本来就是对 ${already}　失败 ${failed}`);
  if (!APPLY) console.log(C.y('（预演，加 --apply 生效）'));
}

void main().catch((e) => {
  console.error(`\n💥 ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
