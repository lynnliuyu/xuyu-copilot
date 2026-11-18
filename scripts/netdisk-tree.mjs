#!/usr/bin/env node
/**
 * 把百度网盘 /apps/bdpan/ 整棵树抓成本地结构化索引，供资源站使用。
 *
 * 产物：out/netdisk-index.json   { generated_at, partial, total_files, total_bytes, tree }
 *      out/.netdisk-cache.json  目录级缓存，重跑只补新增（网盘结构没变就不重复查）
 *
 * 用法：npm run tree:netdisk -- [--max-depth 3] [--conc 4] [--no-cache]
 *
 * 实测结构：类别 / 产品目录 / 文件，基本都是 3 层，所以 max-depth 3 足够。
 * ⚠️ 目录数 700+，单并发要十几分钟 —— 默认并发 4；务必后台跑，别接 `| tail`（会把输出吃掉）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out', 'netdisk-index.json');
const CACHE = path.join(ROOT, 'out', '.netdisk-cache.json');
const BDPAN = path.join(os.homedir(), '.local', 'bin', 'bdpan');

const argv = process.argv.slice(2);
const num = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const MAX_DEPTH = num('--max-depth', 3);
const CONC = num('--conc', 4);
const NO_CACHE = argv.includes('--no-cache');

const cache = !NO_CACHE && fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
let files = 0;
let bytes = 0;
let fetched = 0;
let reused = 0;
let sinceFlush = 0;
let ownerUid = '';
const errors = [];
const t0 = Date.now();

/**
 * 取目录内容。缓存按「该目录自身的 mtime」判失效：
 *   - 父目录列出的子目录 mtime 变了 → 才重新列这个子目录；没变就整棵子树复用。
 *   - 根目录每次都重新查（1 次调用），这是发现顶层变化的唯一途径。
 * 实测：百度网盘的目录 mtime 会随「目录内文件增删」更新，所以这套判据可靠。
 */
async function getList(relPath, claimedMtime) {
  const key = relPath || '/';
  const hit = cache[key];
  if (hit && Array.isArray(hit.entries) && !claimedMtime && relPath === '') {
    // 根目录：不能用 mtime 判，必须重查
  } else if (hit && Array.isArray(hit.entries) && claimedMtime && hit.mtime === claimedMtime) {
    reused += 1;
    return hit.entries;
  }
  const args = ['ls', '--json'];
  if (relPath) args.push(relPath);
  const { stdout } = await pexec(BDPAN, args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PATH: `${path.dirname(BDPAN)}:${process.env.PATH}` },
  });
  const payload = stdout.trim();
  const j = JSON.parse(payload);
  if (!Array.isArray(j)) throw new Error(j.error || '目录响应不是文件列表');
  const list = Array.isArray(j) ? j : [];
  cache[key] = { mtime: claimedMtime || null, entries: list };
  fetched += 1;
  if (++sinceFlush >= 25) { sinceFlush = 0; flush(null, false); }
  return list;
}

/** 简单并发池 */
async function pool(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      await worker(items[k], k);
    }
  });
  await Promise.all(runners);
}

const trim = (x) => ({
  name: x.server_filename,
  dir: !!x.isdir,
  size: Number(x.size) || 0,
  mtime: (x.server_mtime || '').slice(0, 10),
  // 只留 fsid（约 15 位）—— 有了它 + owner_uid + path 就能精确还原官方「在网盘打开」链接，
  // 不必把每条 200~300 字节的完整 URL 写进索引（实测 4042/4042 与官方完全一致）。
  ...(x.isdir ? {} : { fsid: String(x.fsid || '') }),
});

/** 从任意一条的 return_url 里取 owner_uid（各条一致，取一次即可） */
function grabOwnerUid(entries) {
  for (const e of entries) {
    const m = /owner_uid=(\d+)/.exec(e.return_url || '');
    if (m) return m[1];
  }
  return '';
}

async function walk(relPath, depth, claimedMtime) {
  let list;
  try {
    list = await getList(relPath, claimedMtime);
  } catch (e) {
    errors.push({ path: relPath, message: String(e.message).split('\n')[0] });
    console.error(`  ✗ ${relPath || '/'} —— ${String(e.message).split('\n')[0]}`);
    return [];
  }
  if (!ownerUid) ownerUid = grabOwnerUid(list);

  const nodes = [];
  for (const raw of list) {
    if (raw.server_filename.startsWith('.') || raw.path === `/apps/bdpan/${relPath}`) continue;
    const node = trim(raw);
    node.path = (relPath ? `${relPath}/` : '') + node.name;
    if (!node.dir) { files += 1; bytes += node.size; } else { node._mtime = raw.server_mtime || ''; }
    nodes.push(node);
  }

  if (depth < MAX_DEPTH) {
    const dirs = nodes.filter((n) => n.dir);
    await pool(dirs, CONC, async (n) => { n.children = await walk(n.path, depth + 1, n._mtime); });
  }
  for (const n of nodes) delete n._mtime;
  nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : a.dir ? -1 : 1));
  return nodes;
}

function flush(tree, done) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (tree) {
    fs.writeFileSync(
      OUT,
      JSON.stringify({
        generated_at: new Date().toISOString(),
        partial: !done || errors.length > 0,
        errors,
        max_depth: MAX_DEPTH,
        root: '我的应用数据/bdpan',
        owner_uid: ownerUid,
        total_files: files,
        total_bytes: bytes,
        tree,
      }, null, 1),
      'utf8',
    );
  }
  if (!NO_CACHE) fs.writeFileSync(CACHE, JSON.stringify(cache), 'utf8');
  const s = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`  … 新查 ${fetched}　复用子树 ${reused}　文件 ${files}　${s}s`);
}

console.log('══════ 抓取网盘目录树 ══════');
console.log(`  最大深度 ${MAX_DEPTH}　并发 ${CONC}${NO_CACHE ? '　（不用缓存）' : `　缓存已有 ${Object.keys(cache).length} 个目录（旧格式会全量重查一次）`}`);
const tree = await walk('', 0);
flush(tree, true);
const s = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`  完成：重新查询 ${fetched} 个目录　mtime 未变而复用 ${reused} 棵子树`);
console.log(`  文件 ${files} 个　合计 ${(bytes / 1073741824).toFixed(2)} GB　用时 ${s}s`);
console.log(`  → ${path.relative(ROOT, OUT)}`);
