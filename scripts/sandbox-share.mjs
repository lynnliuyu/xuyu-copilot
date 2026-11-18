#!/usr/bin/env node
/**
 * 通用「沙箱转存 + 出链接」器 —— 把某采集器已转存的资源，在【官方 Skill 沙箱】里
 * 再放一份并生成永久分享链接。
 *
 * 为什么必须走沙箱：`bdpan share` 只能分享 /apps/bdpan/ 内的文件，而商品发货需要
 * 一个「我们自己的」链接。所以我们自己的应用目录里的那份，出不了链接。
 *
 * 用法：
 *   node scripts/sandbox-share.mjs --collector assets/gfxcamp-blender --subdir "Blender建模" --limit 20
 *   node scripts/sandbox-share.mjs --collector assets/gfxcamp-blender --subdir "Blender建模" 106266 121949
 *   ... --dry           只打印将要使用的目录名，不写入
 *   ... --skip-usage    跳过沙箱占用统计（那一步很慢）
 *   ... --recheck       对已有记录的条目重新核实（目录空了就作废重做）
 *
 * ⚠️ 三个已踩过的坑，改这个脚本前请先读完：
 *
 * 1. **参数解析**：裸数字**一律视为资源 id**，数量上限必须显式写 `--limit N`。
 *    旧版把第一个裸数字当数量上限，`sandbox-share.mjs 134632 ...` 被理解成
 *    「处理 134632 个」，于是遍历全部资源往沙箱里搬，把账号撑满。
 *
 * 2. **空目录会产出假链接**：`bdpan share` 对空目录照样返回合法链接，买家打开是空的。
 *    所以转存后必须 `statDir()` 核实目录里确实有文件，空目录一律不建链接并标 invalid。
 *
 * 3. **配额**：`errno=13077 exceed quota` 的真实含义是**账号总空间不足**（不是沙箱有独立配额）。
 *    一旦命中就整体中止，避免空转。
 *
 * ⚠️ 另外：`bdpan ls` 对**空目录**会返回一个**同名的自引用条目**，看起来像「里面有个同名
 *    文件夹」。判定空目录时必须过滤 `isdir && server_filename === basename`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BDPAN = process.env.BDPAN_BIN || '/Users/noonebook/.local/bin/bdpan';

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
};

const COLLECTOR = valOf('--collector');
const SUBDIR = valOf('--subdir');
const DRY = has('--dry');
const RECHECK = has('--recheck');
const SKIP_USAGE = has('--skip-usage');
let LIMIT = 4;
const idArgs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--limit') {
    LIMIT = Number(argv[++i]);
    if (!Number.isFinite(LIMIT) || LIMIT <= 0) throw new Error('--limit 需要一个正整数');
    continue;
  }
  // 带值的选项：跳过它的值，别把值当成资源 id
  if (a === '--collector' || a === '--subdir') { i++; continue; }
  if (a.startsWith('--')) continue;
  idArgs.push(a);
}
const ids = idArgs;

if (!COLLECTOR || !SUBDIR) {
  console.error('用法：node scripts/sandbox-share.mjs --collector <dir> --subdir <沙箱子目录> [--limit N] [id...]');
  process.exit(1);
}

const CROOT = path.resolve(PROJ, COLLECTOR);
const OUT = path.join(CROOT, 'data', 'sandbox-share.json');
const rows = JSON.parse(fs.readFileSync(path.join(CROOT, 'resources.json'), 'utf8'));
const log = JSON.parse(fs.readFileSync(path.join(CROOT, 'data', 'transfer-log.json'), 'utf8'));
const okUrls = new Set(Object.entries(log).filter(([, v]) => v.ok).map(([k]) => k));

const eligible = rows.filter((r) => r.cover_local && r.down_links.some((d) => okUrls.has(d.url)));
const picks = ids.length
  ? ids.map((id) => rows.find((r) => String(r.id) === String(id))).filter(Boolean)
  : eligible.slice(0, LIMIT);
if (ids.length) {
  const missing = ids.filter((id) => !rows.some((r) => String(r.id) === String(id)));
  if (missing.length) console.log(`⚠️ 以下 id 在 resources.json 中找不到，已忽略：${missing.join(', ')}`);
}

console.log(
  `采集器 ${COLLECTOR}　沙箱子目录 ${SUBDIR}\n` +
  `可发布资源共 ${eligible.length} 个　本次处理 ${picks.length} 个${DRY ? '（dry-run，不写入）' : ''}\n`,
);

/* ---------------- bdpan 小工具 ---------------- */
async function lsJson(p) {
  try {
    const { stdout } = await exec(BDPAN, ['ls', p, '--json'], { maxBuffer: 1 << 26 });
    const items = JSON.parse(stdout);
    const self = p.split('/').pop();
    // 空目录时 bdpan 返回一个同名自引用条目，必须过滤
    return items.filter((i) => !(i.isdir && i.server_filename === self));
  } catch {
    return [];
  }
}
async function statDir(p) {
  const files = (await lsJson(p)).filter((i) => !i.isdir);
  return { files: files.length, bytes: files.reduce((s, i) => s + (i.size || 0), 0) };
}
async function sandboxUsage() {
  let bytes = 0, files = 0;
  const walk = async (p, depth) => {
    if (depth > 4) return;
    for (const it of await lsJson(p)) {
      if (it.isdir) await walk(it.path, depth + 1);
      else { bytes += it.size || 0; files++; }
    }
  };
  for (const top of await lsJson('')) if (top.isdir) await walk(top.path, 1);
  return { bytes, files };
}

/** 沙箱内目录名：`<资源id>-<清洗后的标题>`。id 是与 resources.json 对齐的唯一锚点。 */
function sanitize(title, maxLen = 120) {
  return String(title ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/, '')
    .slice(0, maxLen)
    .replace(/^[.\s]+|[.\s]+$/, '');
}
const dirName = (r) => `${r.id}-${sanitize(r.title)}`;

/* ---------------- 跑 ---------------- */
const result = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};

let quotaExhausted = false;
const isQuotaErr = (msg) => /13077|exceed quota/i.test(String(msg));

if (!SKIP_USAGE && !DRY) {
  const u = await sandboxUsage();
  console.log(`沙箱当前占用 ≈ ${(u.bytes / 1024 ** 3).toFixed(2)} GB / ${u.files} 文件（占用的是**账号总空间**）\n`);
}

for (const r of picks) {
  if (quotaExhausted) {
    console.log(`\n⛔ 配额已耗尽，停止处理后续资源（本次已处理 ${picks.indexOf(r)} 个）`);
    break;
  }
  const prev = result[String(r.id)];
  const relDir = prev?.dir ? String(prev.dir).replace(/^我的应用数据\/bdpan\//, '') : null;
  const dir = relDir || `${SUBDIR}/${dirName(r)}`;
  console.log(`\n=== ${String(r.title).slice(0, 46)} ===`);

  if (prev?.share_url && !RECHECK) {
    const st = await statDir(dir);
    if (st.files > 0) { console.log(`  ⏭  已有链接且目录非空（${st.files} 文件），跳过`); continue; }
    console.log('  ⚠️  已有链接但目录是空的 → 旧记录无效，重做');
    prev.invalid = true;
    prev.reason = '分享的是空目录（转存失败）';
    delete prev.share_url;
  }

  if (DRY) { console.log(`  [dry] 将使用的目录名：${dir}`); continue; }

  await exec(BDPAN, ['mkdir', dir]).catch(() => {}); // 已存在会报错，忽略

  const want = r.down_links.filter((d) => okUrls.has(d.url));
  console.log(`  待转存 ${want.length} 个版本`);
  const fails = [];
  for (const d of want) {
    try {
      await exec(BDPAN, ['transfer', d.url, '-d', dir]);
      console.log(`    ✅ ${d.label || d.url.slice(-10)}`);
    } catch (e) {
      const msg = String(e.message).split('\n')[0].slice(0, 90);
      fails.push(msg);
      console.log(`    ❌ ${d.label || d.url.slice(-10)} — ${msg}`);
      if (isQuotaErr(msg)) { quotaExhausted = true; break; }
    }
    await new Promise((res) => setTimeout(res, 700));
  }

  // ⭐ 以目录实际内容为准，而不是以 transfer 是否抛错为准
  const st = await statDir(dir);
  if (st.files === 0) {
    result[String(r.id)] = {
      title: r.title,
      share_url: null,
      invalid: true,
      reason: `转存失败或账号空间不足，目录为空；未创建链接。${fails[0] || ''}`,
      dir: `我的应用数据/bdpan/${dir}`,
      versions_ok: 0,
      versions_tried: want.length,
      checked_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    };
    console.log('  🚫 目录为空，跳过分享（否则会产生指向空文件夹的假链接）');
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
    if (quotaExhausted) break;
    continue;
  }

  try {
    const { stdout } = await exec(BDPAN, ['share', dir, '-d', '0']);
    const m = stdout.match(/https:\/\/pan\.baidu\.com\/s\/\S+/);
    const expire = /永久/.test(stdout) ? '永久' : '未知';
    if (m) {
      result[String(r.id)] = {
        title: r.title,
        share_url: m[0],
        expire,
        dir: `我的应用数据/bdpan/${dir}`,
        versions_ok: st.files,
        size_mb: +(st.bytes / 1024 ** 2).toFixed(1),
        checked_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      };
      console.log(`  🔗 ${m[0]}  （${expire}，目录内 ${st.files} 文件 / ${result[String(r.id)].size_mb} MB）`);
    } else {
      console.log(`  ⚠️ 未解析到链接，原始输出：${stdout.slice(0, 120)}`);
    }
  } catch (e) {
    const msg = String(e.message).split('\n')[0].slice(0, 120);
    console.log(`  ❌ 分享失败：${msg}`);
    if (isQuotaErr(msg)) quotaExhausted = true;
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
}

const okCount = Object.values(result).filter((v) => v.share_url).length;
console.log(`\n结果写入 ${OUT}`);
console.log(`累计：有链接 ${okCount} 个 / 记录 ${Object.keys(result).length} 条${quotaExhausted ? '　⚠️ 因配额耗尽提前中止' : ''}`);
