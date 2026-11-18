/**
 * 去重：删除「沙箱里已有副本」的资源的外部副本（只在 /apps/闲鱼商品分享链接管理 内）。
 *
 * 安全逻辑：删任何一个外部文件前，先确认对应沙箱目录**确实存在且非空**；
 * 校验不通过就跳过该文件，绝不盲删。
 *
 * 用法：npx tsx scripts/_dedupe-3d.ts [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { list, quota, filemanager } from '../packages/bdpan-core/src/files';

const ASSET = path.join(process.cwd(), 'assets/gfxcamp-3dmodel');
const DRY = process.argv.includes('--dry');
const SANDBOX_ROOT = '/apps/bdpan/3D模型';

const h = (n: number) =>
  n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB' : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';

const rows: any[] = JSON.parse(fs.readFileSync(path.join(ASSET, 'resources.json'), 'utf8'));
const log: Record<string, any> = JSON.parse(fs.readFileSync(path.join(ASSET, 'data/transfer-log.json'), 'utf8'));
const sbx: Record<string, any> = JSON.parse(fs.readFileSync(path.join(ASSET, 'data/sandbox-share.json'), 'utf8'));
const byId = new Map(rows.map((r) => [String(r.id), r]));

const q0 = await quota();
console.log(`【删除前】used = ${h(q0.used)}   剩余 ${h(Math.max(0, q0.total - q0.used))}\n`);

// 1) 建立「沙箱目录 → 外部副本」映射
interface Pair { id: string; title: string; sbxDir: string; externals: string[]; bytes: number }
const pairs: Pair[] = [];
for (const [id, v] of Object.entries(sbx)) {
  if (!v?.share_url) continue;
  const r = byId.get(id);
  if (!r) continue;
  const externals: string[] = [];
  for (const d of r.down_links ?? []) {
    const rec = log[d.url];
    if (rec?.ok) for (const p of rec.to ?? []) externals.push(p);
  }
  if (!externals.length) continue;
  pairs.push({ id, title: String(v.title ?? r.title), sbxDir: `${SANDBOX_ROOT}/${id}`, externals, bytes: (v.size_mb ?? 0) * 1024 ** 2 });
}

// 2) 逐项安全校验：沙箱目录必须存在且有文件
const toDelete: Array<{ path: string; id: string }> = [];
let skipped = 0;
for (const p of pairs) {
  let ok = false;
  try {
    const items = (await list({ dir: p.sbxDir, limit: 1000 })).filter((x) => x.isdir !== 1);
    ok = items.length > 0;
  } catch {
    ok = false;
  }
  if (!ok) {
    console.log(`⛔ 跳过（沙箱副本缺失/为空）：${p.id}  ${p.title.slice(0, 34)}`);
    skipped++;
    continue;
  }
  for (const e of p.externals) toDelete.push({ path: e, id: p.id });
}
console.log(`\n校验通过：${pairs.length - skipped}/${pairs.length} 个资源，待删外部文件 ${toDelete.length} 个，合计约 ${h(pairs.reduce((s, p) => s + (skipped && 0 ? 0 : p.bytes), 0))}\n`);

if (DRY) {
  for (const d of toDelete) console.log(`  [dry] ${d.path}`);
  process.exit(0);
}

// 3) 分批删除（每批 10）
let okCount = 0;
const failed: string[] = [];
for (let i = 0; i < toDelete.length; i += 10) {
  const batch = toDelete.slice(i, i + 10);
  const res = await filemanager('delete', batch.map((b) => ({ path: b.path })));
  const info = res.info ?? [];
  for (let k = 0; k < batch.length; k++) {
    const errno = info[k]?.errno ?? info.find((x) => x.path === batch[k].path)?.errno;
    if (errno === 0) okCount++;
    else failed.push(`${batch[k].path}  errno=${errno ?? '无返回'}`);
  }
  console.log(`第 ${Math.floor(i / 10) + 1} 批：提交 ${batch.length} 个，成功 ${info.filter((x) => x.errno === 0).length} 个`);
}

// 4) 校验：外部文件是否真的没了
console.log(`\n=== 校验 ===`);
let stillThere = 0;
for (const d of toDelete) {
  const dir = path.dirname(d.path);
  try {
    const items = await list({ dir, limit: 1000 });
    if (items.some((x) => x.path === d.path)) stillThere++;
  } catch {
    /* 目录读不到忽略 */
  }
}
console.log(`提交 ${toDelete.length} 个，接口成功 ${okCount} 个，复查仍存在 ${stillThere} 个`);
if (failed.length) for (const f of failed.slice(0, 10)) console.log(`  ⚠️ ${f}`);

// 5) 分享链接侧复查：沙箱目录仍非空
let linksOk = 0;
for (const p of pairs) {
  try {
    const items = (await list({ dir: p.sbxDir, limit: 100 })).filter((x) => x.isdir !== 1);
    if (items.length > 0) linksOk++;
  } catch {
    /* ignore */
  }
}
console.log(`沙箱副本仍完好：${linksOk}/${pairs.length} 个`);

const q1 = await quota();
console.log(`\n【删除后】used = ${h(q1.used)}   剩余 ${h(Math.max(0, q1.total - q1.used))}`);
console.log(`释放：${h(q0.used - q1.used)}`);
