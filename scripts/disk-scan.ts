/**
 * 全盘占用盘点（只读，不删任何东西）。
 *
 * 用法：npx tsx scripts/disk-scan.ts [根目录=/] [maxDepth=99] [dirBudget=20000]
 *
 * 基于 bdpan-core 的 list（实测不受 /apps 沙箱限制，可遍历全盘），BFS 聚合目录大小。
 * 结果同时写入 out/disk-usage.json，供生成报告用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { list, quota } from '../packages/bdpan-core/src/files';

const human = (n: number) =>
  n >= 1024 ** 4 ? (n / 1024 ** 4).toFixed(2) + ' TB'
  : n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB'
  : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB'
  : n >= 1024 ? (n / 1024).toFixed(0) + ' KB'
  : n + ' B';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const root = process.argv[2] ?? '/';
const maxDepth = Number(process.argv[3] ?? 99);
const budget = Number(process.argv[4] ?? 20000);

interface DirRec { path: string; depth: number; bytes: number; files: number; subdirs: number }
const dirs: DirRec[] = [];
const files: Array<{ path: string; size: number }> = [];
const errors: string[] = [];

const q = await quota().catch(() => null);
if (q) console.log(`账号容量：总 ${human(q.total)} / 已用 ${human(q.used)} / 剩余 ${human(Math.max(0, q.total - q.used))}`);

let visited = 0;
let frontier: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 1 }];

while (frontier.length && visited < budget) {
  const next: Array<{ dir: string; depth: number }> = [];
  for (const { dir, depth } of frontier) {
    if (visited >= budget) break;
    visited++;
    const rec: DirRec = { path: dir, depth, bytes: 0, files: 0, subdirs: 0 };
    let start = 0;
    for (;;) {
      let batch: Awaited<ReturnType<typeof list>> = [];
      try {
        batch = await list({ dir, start, limit: 1000 });
      } catch (e: any) {
        errors.push(`${dir}: ${e?.message ?? e}`);
        break;
      }
      for (const e of batch) {
        if (e.isdir === 1) {
          rec.subdirs++;
          if (depth < maxDepth) next.push({ dir: e.path, depth: depth + 1 });
        } else {
          rec.files++;
          rec.bytes += e.size ?? 0;
          files.push({ path: e.path, size: e.size ?? 0 });
        }
      }
      if (batch.length < 1000) break;
      start += batch.length;
      await sleep(120);
    }
    dirs.push(rec);
    if (visited % 100 === 0) console.error(`  …已扫描 ${visited} 个目录 / ${files.length} 个文件`);
    await sleep(120);
  }
  frontier = next;
}

// 聚合：把每个目录的「直接文件大小」累加到它自己和所有祖先（各一次，不重复计）
const agg = new Map<string, number>();
for (const rec of dirs) {
  let cur = rec.path;
  for (;;) {
    agg.set(cur, (agg.get(cur) ?? 0) + rec.bytes);
    if (cur === '/') break;
    const i = cur.lastIndexOf('/');
    cur = i <= 0 ? '/' : cur.slice(0, i);
  }
}

const totalBytes = files.reduce((s, f) => s + f.size, 0);
console.log(`\n扫描完成：访问 ${visited} 个目录 / ${files.length} 个文件${errors.length ? ` / ${errors.length} 个读取失败` : ''}`);
console.log(`本次扫描到文件合计：${human(totalBytes)}\n`);

const topDirs = dirs
  .map((d) => ({ ...d, total: agg.get(d.path) ?? 0 }))
  .filter((d) => d.total > 0)
  .sort((a, b) => b.total - a.total);

console.log(`=== 最大的 40 个目录（含全部子孙）===`);
for (const d of topDirs.slice(0, 40)) console.log(`  ${human(d.total).padStart(10)}   ${d.path}  (${d.files} 直接文件 / ${d.subdirs} 子目录)`);

console.log(`\n=== 最大的 40 个文件 ===`);
for (const f of [...files].sort((a, b) => b.size - a.size).slice(0, 40)) console.log(`  ${human(f.size).padStart(10)}   ${f.path}`);

if (errors.length) {
  console.log(`\n读取失败的目录（前 10 条）：`);
  for (const e of errors.slice(0, 10)) console.log('  ' + e);
}

const outDir = path.join(process.cwd(), 'out');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'disk-usage.json');
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      scannedAt: new Date().toISOString(),
      root,
      quota: q,
      stats: { visited, files: files.length, errors: errors.length, totalBytes },
      topDirs: topDirs.map((d) => ({ path: d.path, total: d.total, files: d.files, subdirs: d.subdirs })),
      topFiles: [...files].sort((a, b) => b.size - a.size).slice(0, 300),
    },
    null,
    2,
  ) + '\n',
);
console.log(`\n结果已写入 ${outFile}`);
