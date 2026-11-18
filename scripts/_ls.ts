/** 临时工具：按大小倒序列出某个目录的直接条目（自动翻页）。用法：npx tsx scripts/_ls.ts <dir> [limit] */
import { list } from '../packages/bdpan-core/src/files';

const h = (n: number) =>
  n >= 1024 ** 4 ? (n / 1024 ** 4).toFixed(2) + ' TB'
  : n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB'
  : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB'
  : n >= 1024 ? (n / 1024).toFixed(0) + ' KB'
  : n + ' B';

const dir = process.argv[2] ?? '/';
const limit = Number(process.argv[3] ?? 200);
const rows = [];
for (let start = 0; ; start += 1000) {
  const batch = await list({ dir, start, limit: 1000 });
  rows.push(...batch);
  if (batch.length < 1000) break;
}
const dirs = rows.filter((r) => r.isdir === 1);
const files = rows.filter((r) => r.isdir !== 1);
console.log(`=== ${dir} ===`);
console.log(`目录 ${dirs.length} 个 / 文件 ${files.length} 个 / 直接文件合计 ${h(files.reduce((s, f) => s + (f.size ?? 0), 0))}\n`);
for (const f of files.sort((a, b) => (b.size ?? 0) - (a.size ?? 0)).slice(0, limit)) console.log(`  ${h(f.size ?? 0).padStart(10)}  ${f.server_filename}`);
if (dirs.length) {
  console.log(`\n  -- 子目录（${dirs.length} 个）--`);
  for (const d of dirs.slice(0, limit)) console.log(`  [目录] ${d.server_filename}`);
}
