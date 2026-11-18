/**
 * 卡种 ↔ 商品 绑定工具（对应闲管家后台「卡密仓库 → 发货 → 关联商品」）。
 *
 * 2026-10-19 实测结论：
 *   · 这一步**有 API** —— `kami/kind/edit` 接受 `app_id`(number) + `goods_no`(string)
 *   · `app_id` 必须填真实应用 ID（本项目 1788532675364357 / bdmcp-xy-j）；
 *     填 0 时服务端**静默丢弃 goods_no**，且不报错
 *   · 服务端**不校验商品是否存在**，填错编号同样"成功" ⇒ 必须自己核对
 *
 * 用法：
 *   tsx scripts/kami-bind.ts --list                      看现状
 *   tsx scripts/kami-bind.ts --bind 1800... --to BD-GFX-124840            预演
 *   tsx scripts/kami-bind.ts --bind 1800... --to BD-GFX-124840 --apply    真写
 *   tsx scripts/kami-bind.ts --unbind 1800... --apply                     解除关联
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  listKamiKinds,
  bindKamiKindToGoods,
  unbindKamiKind,
} from '../packages/goofish-adapter/src/api';
import { appIdFromEnv } from '../packages/goofish-adapter/src/config';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const argv = process.argv.slice(2);

function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

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

function loadListings(): Record<string, Listing> {
  const p = path.join(ROOT, 'drafts', '.listings.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, Listing>;
}

function loadCardCodes(): string[] {
  const p = path.join(ROOT, 'packages', 'xgj-gateway', 'data', 'cards.json');
  if (!fs.existsSync(p)) return [];
  return Object.keys(JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>);
}

async function cmdList() {
  const kinds = await listKamiKinds();
  const listings = loadListings();
  console.log(C.b(`\n卡种 ${kinds.length} 个　应用 ID ${appIdFromEnv()}\n`));
  console.log('kind_id           绑定商品        卡密  卡种名');
  console.log('─'.repeat(78));
  let bound = 0;
  for (const k of kinds) {
    const no = String(k.goods_no ?? '');
    if (no) bound++;
    const mark = no ? C.g(no.padEnd(15)) : C.y('（未绑定）'.padEnd(13));
    const title = listings[no]?.title ? String(listings[no].title).slice(0, 22) : '';
    const stock = String(k.stock ?? '-').padStart(4);
    console.log(`${String(k.kind_id).padEnd(19)}${mark}${stock}  ${String(k.kind_name ?? '').slice(0, 24)}`);
    if (title) console.log(C.dim(`                   └ 台账: ${title}`));
  }
  console.log('─'.repeat(78));
  console.log(`已绑定 ${bound} / ${kinds.length}\n`);
}

async function cmdBind(kindId: number, code: string, apply: boolean) {
  const listings = loadListings();
  const row = listings[code];
  const cards = loadCardCodes();
  const hasCard = cards.includes(code);

  console.log(C.b('\n绑定预检'));
  console.log(`  卡种        ${kindId}`);
  console.log(`  商品编号    ${code}`);
  console.log(`  台账标题    ${row?.title ?? C.r('❌ 台账里没有这个 code')}`);
  console.log(`  台账 product_id ${row?.product_id ?? '-'}　线上 item_id ${row?.item_id ?? '-'}`);
  console.log(`  卡密池      ${hasCard ? C.g('有') : C.y('没有（绑了也发不出货）')}`);
  console.log(`  app_id      ${appIdFromEnv()}（${appIdFromEnv() ? C.g('已配置') : C.r('缺失')}）`);

  if (!row) {
    console.log(C.r('\n❌ 中止：编号在台账里对不上，绑上去就是"静默错绑"。'));
    process.exitCode = 1;
    return;
  }
  if (!apply) {
    console.log(C.y('\n（预演）加 --apply 才会真写。'));
    return;
  }

  console.log(C.b('\n执行绑定…'));
  const r = await bindKamiKindToGoods({ kind_id: kindId, goods_no: code, goods_name: row.title });
  console.log(C.g(`✅ 已绑定并读回核对：app_id=${r.app_id} goods_no=${r.goods_no}`));
}

async function cmdUnbind(kindId: number, apply: boolean) {
  if (!apply) {
    console.log(C.y(`（预演）将解除卡种 ${kindId} 的商品关联。加 --apply 生效。`));
    return;
  }
  await unbindKamiKind(kindId);
  console.log(C.g(`✅ 卡种 ${kindId} 已解除关联`));
}

async function main() {
  const apply = flag('apply');

  if (flag('list') || argv.length === 0) {
    await cmdList();
    return;
  }

  const bindId = opt('bind');
  if (bindId) {
    const to = opt('to');
    if (!to) {
      console.error('❌ --bind 需要配合 --to <商品编号>');
      process.exitCode = 1;
      return;
    }
    await cmdBind(Number(bindId), to, apply);
    return;
  }

  const unbindId = opt('unbind');
  if (unbindId) {
    await cmdUnbind(Number(unbindId), apply);
    return;
  }

  console.log('用法：--list | --bind <kind_id> --to <code> [--apply] | --unbind <kind_id> [--apply]');
}

void main().catch((e) => {
  console.error(C.r(`\n❌ ${e instanceof Error ? e.message : String(e)}`));
  process.exitCode = 1;
});
