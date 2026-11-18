/**
 * 把已建好的卡种从「进销存应用」改绑到「虚拟货源应用」（bd-to-xy）。
 *
 * 背景（2026-10-19 实测）：卡密的「关联货源」必须指向 bd-to-xy，
 * 之前错填了 bdmcp-xy-j（进销存）。判据是服务端会不会回填 `goods_name`：
 *   · app_id=bdmcp-xy-j → goods_name 为空（不认）
 *   · app_id=bd-to-xy   → goods_name 自动回填（认）
 *
 * 只改 app_id，goods_no / 卡密库存 / 卡种名全部保持不变。
 *
 * 用法：
 *   npx tsx scripts/kami-retarget-app.ts --dry
 *   npx tsx scripts/kami-retarget-app.ts --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getKamiKind, bindKamiKindToGoods, listKamiKinds } from '../packages/goofish-adapter/src/api';
import { appIdFromEnv } from '../packages/goofish-adapter/src/config';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'out', 'kami-auto-state.json');
const APPLY = process.argv.includes('--apply');

const C = {
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

async function main() {
  const target = appIdFromEnv();
  if (!target) {
    console.error('❌ .env 里没有 GOOFISH_APP_KEY（虚拟货源应用）');
    process.exitCode = 1;
    return;
  }

  // ⚠️ `kami/kind/list` 有分页，默认只返回 50 条 —— 必须用本地状态文件驱动，
  //    否则 344 个卡种只处理前 50 个，剩下的静默漏掉。
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8')) as Record<
    string,
    { kind_id: number; code: string }
  >;
  const bound = Object.entries(state).map(([code, v]) => ({ kind_id: v.kind_id, goods_no: code }));
  console.log(C.b(`\n状态文件里 ${bound.length} 个卡种`));
  console.log(`目标货源应用 app_id = ${target}（bd-to-xy）`);
  console.log(`模式：${APPLY ? '真实写入' : '预演'}\n`);

  let changed = 0;
  let already = 0;
  let failed = 0;

  for (const k of bound) {
    const kindId = Number(k.kind_id);
    const code = String(k.goods_no);
    if (!APPLY) {
      const cur = (await getKamiKind(kindId)) as never as Record<string, unknown>;
      if (Number(cur.app_id) === target) {
        already++;
      } else {
        changed++;
        if (changed <= 3) console.log(`  将改 ${code} kind_id=${kindId} app_id ${cur.app_id} → ${target}`);
      }
      await new Promise((r) => setTimeout(r, 60));
      continue;
    }
    try {
      const before = (await getKamiKind(kindId)) as never as Record<string, unknown>;
      if (Number(before.app_id) === target) {
        already++;
        continue;
      }
      await bindKamiKindToGoods({ kind_id: kindId, goods_no: code, app_id: target });
      const after = (await getKamiKind(kindId)) as never as Record<string, unknown>;
      const ok = String(after.goods_name ?? '').trim().length > 0;
      if (ok) {
        changed++;
        if (changed % 20 === 0) console.log(`  …已改 ${changed}`);
      } else {
        failed++;
        console.log(`  ${C.y('⚠')} ${code} 改了但 goods_name 仍为空（kind_id=${kindId}）`);
      }
    } catch (e: unknown) {
      failed++;
      console.log(`  ${C.r('✗')} ${code} ${e instanceof Error ? e.message.slice(0, 90) : e}`);
    }
  }

  console.log(`\n${C.b('汇总')}　待改 ${changed}　已是目标 ${already}　失败 ${failed}`);
  if (!APPLY) console.log(C.y('（预演，加 --apply 生效）'));
}

void main().catch((e) => {
  console.error(`\n💥 ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
