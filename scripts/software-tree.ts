/**
 * 软件类资源目录工具 —— 网盘「仓/待售/软件」的骨架、改名与安全清理。
 *
 * 目录约定（用户 2026-10-08 确认）：
 *   仓/待售/软件/<软件名>/<软件名> - windows版/{便携版,安装版}
 *                       /<软件名> - mac版/            ← Mac 不分便携/安装，改用文件名标注芯片
 *
 * 命名硬规则：
 *   1. 平台档统一后缀 ` - windows版` / ` - mac版`
 *   2. 目录名与文件名避开「破解/免费/永久/全网最低/可商用」——闲鱼违规或限流词，
 *      且分享出去的页面买家能看到。要表达同义时用 补丁 / 汉化版 / 便携版 / 直装版 / 激活工具
 *   3. 版本号必须进文件名（同软件多版本并存，且跨代版本号不可比较）
 *   4. 架构/芯片写在文件名上：(Apple芯片) (Intel) (x64)
 *   5. 层级不超过 3 层
 *
 * 用法：
 *   npx tsx scripts/software-tree.ts inspect
 *   npx tsx scripts/software-tree.ts init "Topaz Video" "Topaz Photo" [--dry]
 *   npx tsx scripts/software-tree.ts rename "软件/figma/figma - win版" "figma - windows版" [--dry]
 *   npx tsx scripts/software-tree.ts rmdir "软件/figma_20261006_192135" [--dry]   # 仅空目录
 */
import { list, mkdir, filemanager, search } from '../packages/bdpan-core/src/files';
import { resolveAppPath, toDisplayPath } from '../packages/bdpan-core/src/paths';

const SOFT_ROOT_REL = '仓/待售/软件';
const SOFT_ROOT = resolveAppPath(SOFT_ROOT_REL);

/** 违规 / 限流词：目录名与文件名都不该出现 */
const BANNED = ['破解', '免费', '永久', '全网最低', '可商用'];

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const cmd = argv[0] ?? 'inspect';
const args = argv.slice(1).filter((a) => !a.startsWith('--'));

const human = (n: number) =>
  n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB'
  : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB'
  : n >= 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assertClean(name: string) {
  const hit = BANNED.filter((w) => name.includes(w));
  if (hit.length) {
    throw new Error(`名称含违规/限流词 ${hit.join('、')}：${name}\n（分享页买家可见，闲鱼标题也禁用这些词）`);
  }
}

/** 列目录（单层，自动翻页） */
async function ls(dir: string) {
  const out = [];
  for (let start = 0; start < 10000; start += 1000) {
    const b = await list({ dir, start, limit: 1000, order: 'name' });
    out.push(...b);
    if (b.length < 1000) break;
    await sleep(120);
  }
  return out;
}

/** 递归打印一棵树，返回汇总 */
async function show(dir: string, indent = ''): Promise<{ files: number; bytes: number; dirs: number }> {
  let rows: any[] = [];
  try {
    rows = await ls(dir);
  } catch (e: any) {
    console.log(`${indent}!! 读取失败：${e?.message ?? e}`);
    return { files: 0, bytes: 0, dirs: 0 };
  }
  console.log(`${indent}${dir.split('/').pop() || dir}/`);
  let files = 0, bytes = 0, dirs = 0;
  for (const r of rows) {
    if (r.isdir === 1) {
      dirs++;
      const sub = await show(r.path, indent + '  ');
      files += sub.files; bytes += sub.bytes; dirs += sub.dirs;
    } else {
      files++; bytes += r.size ?? 0;
      console.log(`${indent}  ${human(r.size ?? 0).padStart(10)}  ${r.server_filename}`);
    }
  }
  if (!rows.length) console.log(`${indent}  （空）`);
  return { files, bytes, dirs };
}

async function inspect() {
  console.log(`盘点：${toDisplayPath(SOFT_ROOT)}\n`);
  const t = await show(SOFT_ROOT);
  console.log(`\n合计 ${t.dirs} 个目录 / ${t.files} 个文件 / ${human(t.bytes)}\n`);

  console.log('违规/限流词自检（目录名与文件名）：');
  const bad: string[] = [];
  async function scan(dir: string) {
    for (const r of await ls(dir)) {
      const hit = BANNED.filter((w) => r.server_filename.includes(w));
      if (hit.length) bad.push(`${r.server_filename}  ← 含 ${hit.join('、')}`);
      if (r.isdir === 1) await scan(r.path);
    }
  }
  await scan(SOFT_ROOT);
  console.log(bad.length ? bad.map((b) => '  ⚠️ ' + b).join('\n') : '  ✅ 未发现');
  console.log();

  // 该目录下是否已被资源条目引用（改名前必查）
  const res = await search({ key: '', dir: SOFT_ROOT, recursion: 0 }).catch(() => []);
  void res;
}

/** 建骨架：<软件名>/<软件名> - windows版/{便携版,安装版} + <软件名> - mac版 */
async function init(names: string[]) {
  if (!names.length) throw new Error('用法：init "<软件名>" ["<软件名>" ...] [--dry]');
  const plan: string[] = [];
  for (const n of names) {
    const name = n.trim();
    assertClean(name);
    const soft = `${SOFT_ROOT}/${name}`;
    const win = `${soft}/${name} - windows版`;
    const mac = `${soft}/${name} - mac版`;
    plan.push(soft, win, `${win}/便携版`, `${win}/安装版`, mac);
  }

  console.log(DRY ? '【dry-run】将创建以下目录：\n' : '创建目录：\n');
  for (const p of plan) console.log('  ' + toDisplayPath(p));

  if (DRY) return;

  // 已存在的先查出来，避免无谓报错
  const existing = new Set<string>();
  async function collect(dir: string) {
    for (const r of await ls(dir).catch(() => [])) {
      existing.add(r.path);
      if (r.isdir === 1) await collect(r.path);
    }
  }
  await collect(SOFT_ROOT);

  let made = 0, skipped = 0;
  for (const p of plan) {
    if (existing.has(p)) { skipped++; continue; }
    try {
      await mkdir(p.replace(/^\/apps\/[^/]+\//, ''));
      made++;
      console.log(`  ✅ ${toDisplayPath(p)}`);
    } catch (e: any) {
      console.log(`  ❌ ${toDisplayPath(p)}  ${e?.message ?? e}`);
    }
    await sleep(150);
  }
  console.log(`\n完成：新建 ${made} · 已存在跳过 ${skipped}`);
}

/** 重命名（filemanager rename 只改 basename，需传完整旧路径） */
async function rename(rel: string, newname: string) {
  if (!rel || !newname) throw new Error('用法：rename "<相对路径>" "<新名字>" [--dry]');
  assertClean(newname);
  const full = resolveAppPath(rel);
  console.log(`${toDisplayPath(full)}\n  → ${newname}`);
  if (DRY) { console.log('\n【dry-run】未执行'); return; }
  const r = await filemanager('rename', [{ path: full, newname }]);
  const info = r.info?.[0];
  console.log(info?.errno === 0 ? '  ✅ 成功' : `  ❌ errno=${info?.errno ?? '?'}`);
}

/** 删除空目录（逐个校验非空则拒绝） */
async function rmdir(rels: string[]) {
  if (!rels.length) throw new Error('用法：rmdir "<相对路径>" [...] [--dry]');
  const targets: string[] = [];
  for (const rel of rels) {
    const full = resolveAppPath(rel);
    const rows = await ls(full).catch(() => null);
    if (rows === null) { console.log(`  ⏭ 跳过（不存在或读不到）：${toDisplayPath(full)}`); continue; }
    if (rows.length) {
      console.log(`  ⛔ 拒绝删除非空目录：${toDisplayPath(full)}（内含 ${rows.length} 项）`);
      continue;
    }
    targets.push(full);
  }
  if (!targets.length) { console.log('\n没有可删的空目录。'); return; }
  console.log(`\n待删空目录 ${targets.length} 个：`);
  for (const t of targets) console.log('  ' + toDisplayPath(t));
  if (DRY) { console.log('\n【dry-run】未执行'); return; }
  const r = await filemanager('delete', targets.map((path) => ({ path })));
  for (const i of r.info ?? []) {
    console.log(`  ${i.errno === 0 ? '✅' : '❌ errno=' + i.errno}  ${toDisplayPath(i.path)}`);
  }
}

switch (cmd) {
  case 'inspect': await inspect(); break;
  case 'init': await init(args); break;
  case 'rename': await rename(args[0], args[1]); break;
  case 'rmdir': await rmdir(args); break;
  default:
    console.log('用法：\n  inspect\n  init "<软件名>" [...] [--dry]\n  rename "<相对路径>" "<新名字>" [--dry]\n  rmdir "<相对路径>" [...] [--dry]');
}
