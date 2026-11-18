import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAll, walkTree, CATEGORY, type FileEntry } from '../index';
import { normalizePath, toDisplayPath, hasAppRoot, isUnderApp } from '../paths';
import { tokenStatus } from '../token';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function human(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

const ext = (name: string) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '(无扩展名)';
};

/**
 * 合规预筛：命中即标记疑点，进入人工复核，不进候选池。
 * 这是**拦截**而非建议 —— 只上架自有版权或已获授权的内容。
 */
const RISK_PATTERNS: Array<[RegExp, string]> = [
  [/破解|绿色版|免安装|注册机|keygen|crack|patched|crked|activate/i, '疑似破解/盗版软件'],
  [/盗版|搬运|全网最全|付费课程|网课|课程全集|内部资料|绝版/i, '疑似版权风险内容'],
  [/激活|序列号|license|授权码|key/i, '疑似激活类'],
  [/软件|安装包|setup|installer|dmg|exe/i, '软件类（版权待确认）'],
];

interface DirStat {
  path: string;
  files: number;
  dirs: number;
  size: number;
  risk: number;
}

function buildDirStats(entries: FileEntry[], rootPath: string): DirStat[] {
  const map = new Map<string, DirStat>();
  const touch = (p: string): DirStat => {
    let s = map.get(p);
    if (!s) {
      s = { path: p, files: 0, dirs: 0, size: 0, risk: 0 };
      map.set(p, s);
    }
    return s;
  };
  touch(rootPath);

  for (const e of entries) {
    const parent = path.posix.dirname(e.path);
    const s = touch(parent);
    if (e.isdir === 1) s.dirs += 1;
    else {
      s.files += 1;
      s.size += e.size ?? 0;
      if (RISK_PATTERNS.some(([re]) => re.test(e.server_filename))) s.risk += 1;
    }
    // 让每一层祖先目录都能被统计到
    let cur = parent;
    while (cur.startsWith(rootPath) && cur !== rootPath) {
      cur = path.posix.dirname(cur);
      touch(cur);
    }
  }
  return [...map.values()].sort((a, b) => b.size - a.size);
}

async function main() {
  const root = normalizePath(arg('path', '/'));
  const max = Number(arg('max', '50000'));
  const depth = Number(arg('depth', '0'));
  const mode = arg('mode', 'auto');

  const useListall =
    mode === 'listall' || (mode === 'auto' && hasAppRoot() && isUnderApp(root));

  console.log('=== 网盘盘点 ===\n');
  console.log(`令牌状态 : ${tokenStatus()}`);
  console.log(`扫描目录 : ${toDisplayPath(root)}`);
  console.log(`API 路径 : ${root}`);
  console.log(`遍历方式 : ${useListall ? 'listall（递归接口）' : 'list 自建 BFS（全盘可用）'}`);
  console.log(`上限     : ${max} 条${depth ? `，深度 ${depth}` : ''}\n`);

  const t0 = Date.now();
  let dirsVisited = 0;
  const onDir = (dir: string, filesInDir: number, totalFiles: number) => {
    dirsVisited += 1;
    process.stderr.write(`\r  已遍历 ${dirsVisited} 个目录 / ${totalFiles} 个文件   ${dir.slice(0, 60).padEnd(60)}`);
  };

  const entries = useListall
    ? await listAll({ path: root, recursion: 1, max, onPage: (_, t) => process.stderr.write(`\r  已拉取 ${t} 条...`) })
    : await walkTree({ root, max, intervalMs: 120, maxDepth: depth || undefined, onDir });
  process.stderr.write('\n');
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const files = entries.filter((e) => e.isdir === 0);
  const dirs = entries.filter((e) => e.isdir === 1);
  const totalSize = files.reduce((a, e) => a + (e.size ?? 0), 0);

  const byCategory = new Map<string, { count: number; size: number }>();
  const byExt = new Map<string, { count: number; size: number }>();
  const risk = new Map<string, FileEntry[]>();

  for (const f of files) {
    const cat = CATEGORY[f.category ?? 0] ?? '未知';
    const c = byCategory.get(cat) ?? { count: 0, size: 0 };
    c.count += 1;
    c.size += f.size ?? 0;
    byCategory.set(cat, c);

    const e = ext(f.server_filename);
    const x = byExt.get(e) ?? { count: 0, size: 0 };
    x.count += 1;
    x.size += f.size ?? 0;
    byExt.set(e, x);

    for (const [re, label] of RISK_PATTERNS) {
      if (re.test(f.server_filename)) {
        const arr = risk.get(label) ?? [];
        arr.push(f);
        risk.set(label, arr);
        break;
      }
    }
  }

  const dirStats = buildDirStats(entries, root);
  const topLevel = dirStats.filter((d) => d.path !== root && path.posix.dirname(d.path) === root);

  const outDir = path.join(ROOT, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = arg('out') ?? path.join(outDir, `scan-${stamp}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        scannedAt: new Date().toISOString(),
        root,
        mode: useListall ? 'listall' : 'walkTree',
        totalSize,
        counts: { all: entries.length, files: files.length, dirs: dirs.length },
        byCategory: Object.fromEntries([...byCategory].sort((a, b) => b[1].size - a[1].size)),
        byExt: Object.fromEntries([...byExt].sort((a, b) => b[1].count - a[1].count)),
        risk: Object.fromEntries([...risk].map(([k, v]) => [k, v.map((f) => f.path)])),
        dirStats,
        entries: entries.map((e) => ({
          fs_id: e.fs_id,
          path: e.path,
          name: e.server_filename,
          isdir: e.isdir,
          size: e.size,
          category: e.category,
          md5: e.md5,
          server_mtime: e.server_mtime,
        })),
      },
      null,
      2,
    ),
  );

  console.log('--- 总览 ---');
  console.log(`耗时       : ${elapsed}s`);
  console.log(`条目总数   : ${entries.length}（文件 ${files.length} / 目录 ${dirs.length}）`);
  console.log(`文件总大小 : ${human(totalSize)}`);

  if (topLevel.length) {
    console.log('\n--- 顶层目录概览 ---');
    for (const d of [...topLevel].sort((a, b) => b.size - a.size)) {
      console.log(
        `  ${human(d.size).padStart(10)}  ${String(d.files).padStart(6)} 文件  ${String(d.dirs).padStart(4)} 子目录  ${path.posix.basename(d.path)}`,
      );
    }
  }

  console.log('\n--- 按类型 ---');
  for (const [k, v] of [...byCategory].sort((a, b) => b[1].size - a[1].size)) {
    console.log(`  ${k.padEnd(6, ' ')} ${String(v.count).padStart(6)} 个   ${human(v.size)}`);
  }

  console.log('\n--- 扩展名 Top 15 ---');
  for (const [k, v] of [...byExt].sort((a, b) => b[1].count - a[1].count).slice(0, 15)) {
    console.log(`  .${k.padEnd(12, ' ')} ${String(v.count).padStart(6)} 个   ${human(v.size)}`);
  }

  console.log('\n--- 目录占用 Top 20 ---');
  for (const d of dirStats.filter((d) => d.files > 0).slice(0, 20)) {
    console.log(
      `  ${human(d.size).padStart(10)}  ${String(d.files).padStart(6)} 文件  ${toDisplayPath(d.path)}`,
    );
  }

  if (risk.size) {
    console.log('\n--- 合规预筛命中（需人工复核，不得直接上架）---');
    for (const [label, list] of risk) {
      console.log(`  [${label}] ${list.length} 个`);
      for (const f of list.slice(0, 8)) console.log(`      · ${f.server_filename}`);
      if (list.length > 8) console.log(`      · ... 另外 ${list.length - 8} 个`);
    }
  }

  console.log(`\n完整结果已写入：${outFile}`);
}

main().catch((err) => {
  console.error('\n扫描失败：', err?.message ?? err);
  process.exit(1);
});
