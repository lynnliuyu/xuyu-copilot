/**
 * 按确认后的清单执行删除（分批 + 逐步校验）。
 * 用法：npx tsx scripts/_clean.ts [--dry]
 */
import { list, quota, filemanager } from '../packages/bdpan-core/src/files';

const DRY = process.argv.includes('--dry');
const DIR = '/X1a0He Plugin for Mac 微信小助手  增强插件(多开、消息防撤回、禁用更新和日志上报）仅支持M芯片';
const KEEP = 3; // 保留最新 N 个版本

const EMPTY_DIRS = [
  '/apps/闲鱼商品分享链接管理/仓_20261006_192052',
  '/apps/闲鱼商品分享链接管理/仓_20261006_192133',
  '/apps/闲鱼商品分享链接管理/仓_20261006_192540',
  '/apps/闲鱼商品分享链接管理/仓/待售_20261006_192052',
  '/apps/闲鱼商品分享链接管理/仓/待售_20261006_192133',
  '/apps/闲鱼商品分享链接管理/仓/待售_20261006_192541',
];

const h = (n: number) =>
  n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB' : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';

const ver = (n: string) => {
  const m = /Plugin v([\d.]+)/.exec(n);
  return m ? m[1].split('.').map(Number) : [0];
};

const q0 = await quota();
console.log(`【删除前】used = ${h(q0.used)}  (${q0.used} B)  剩余 ${h(Math.max(0, q0.total - q0.used))}`);

const rows = (await list({ dir: DIR, limit: 1000 })).filter((r) => r.isdir !== 1);
rows.sort((a, b) => {
  const A = ver(a.server_filename);
  const B = ver(b.server_filename);
  for (let i = 0; i < Math.max(A.length, B.length); i++) if ((B[i] ?? 0) !== (A[i] ?? 0)) return (B[i] ?? 0) - (A[i] ?? 0);
  return 0;
});
const keep = rows.slice(0, KEEP);
const drop = rows.slice(KEEP);
console.log(`\n保留 ${keep.length} 个：`);
for (const k of keep) console.log(`  ✔ ${k.server_filename}  ${h(k.size ?? 0)}`);
console.log(`\n待删 ${drop.length} 个，合计 ${h(drop.reduce((s, r) => s + (r.size ?? 0), 0))}`);

if (DRY) {
  for (const d of drop) console.log(`  [dry] ${d.path}`);
  process.exit(0);
}

// 分批删除，每批 10 个，逐批核实
let okAll = 0;
for (let i = 0; i < drop.length; i += 10) {
  const batch = drop.slice(i, i + 10);
  const res = await filemanager('delete', batch.map((b) => ({ path: b.path })));
  const info = res.info ?? [];
  const ok = info.filter((x) => x.errno === 0).length;
  okAll += ok;
  console.log(`\n第 ${Math.floor(i / 10) + 1} 批：提交 ${batch.length} 个，成功 ${ok} 个`);
  for (const x of info) if (x.errno !== 0) console.log(`  ⚠️ errno=${x.errno}  ${x.path}`);
  if (info.length === 0) console.log(`  （接口未返回明细，taskid=${res.taskid ?? '无'}）`);
}

// 空目录
console.log(`\n删除 ${EMPTY_DIRS.length} 个空目录：`);
const r2 = await filemanager('delete', EMPTY_DIRS.map((p) => ({ path: p })));
for (const x of r2.info ?? []) console.log(`  ${x.errno === 0 ? '✔' : '⚠️ errno=' + x.errno}  ${x.path}`);

// 校验
const left = (await list({ dir: DIR, limit: 1000 })).filter((r) => r.isdir !== 1);
console.log(`\n【校验】该目录剩余 ${left.length} 个文件（应为 ${keep.length}）：`);
for (const l of left) console.log(`  · ${l.server_filename}  ${h(l.size ?? 0)}`);

const q1 = await quota();
console.log(`\n【删除后】used = ${h(q1.used)}  (${q1.used} B)`);
console.log(`变化：${h(q1.used - q0.used)}   （负数=已释放；≈0 说明只是进了回收站、空间未释放）`);
console.log(`剩余空间：${h(Math.max(0, q1.total - q1.used))}`);
