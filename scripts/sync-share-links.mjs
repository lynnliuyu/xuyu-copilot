#!/usr/bin/env node
/**
 * 把「网盘分享台账」同步到「关键词回复链接表」
 *
 * ── 为什么需要这个脚本
 *   分享链接早就建好了，台账 `out/netdisk-shares.json` 里有 774 条（软件/ 下 22 条）。
 *   但关键词回复读的是 `assets/free-software/netdisk-links.json` —— 那张表一直是空的。
 *   两个数据源没打通，结果就是：文章发出去了、读者回复关键词，只拿到「[网盘链接占位]」。
 *   靠手工填迟早漏，所以做成同步。
 *
 * ── 为什么不做成"自动同步"
 *   网盘文件夹名（`MediaInfo GUI`）和项目 id（`mediainfo-gui`）不是同一个东西，
 *   得靠 manifest + 体检产物做映射。映射不可能 100% 准，所以：
 *   · 默认**只补空位**，已填的值不动（避免把手工修正过的覆盖掉）
 *   · 要强制覆盖加 `--force`
 *   · 对不上的会列出来，不静默丢
 *
 * 用法：
 *   node scripts/sync-share-links.mjs             # 补空位
 *   node scripts/sync-share-links.mjs --dry       # 只看会改什么
 *   node scripts/sync-share-links.mjs --force     # 用台账覆盖已有值
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const LEDGER = path.join(ROOT, 'out', 'netdisk-shares.json');
const ADDR = path.join(ROOT, 'assets', 'free-software', 'netdisk-links.json');
const MANIFEST = path.join(ROOT, 'assets', 'free-software', 'manifest.json');
const AUDIT = path.join(ROOT, 'out', 'gh-audit.json');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const FORCE = argv.includes('--force');
const ROOT_DIR = process.env.NETDISK_FREE_DIR || '软件';

if (!fs.existsSync(LEDGER)) {
  console.error('❌ 没有分享台账 out/netdisk-shares.json —— 先跑 npm run share:netdisk');
  process.exit(1);
}

const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')).shares || {};
const readJson = (p, d) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : d);
const addr = readJson(ADDR, {});
const manifest = readJson(MANIFEST, { items: [] }).items || [];
const audit = readJson(AUDIT, { items: [] }).items || [];

// ── 建「规范化名字 → 项目 id」索引 ─────────────────────────────────
// ⚠️ 必须**保留汉字**。早期版本把非 [a-z0-9] 全删掉，后果是：
//    · 「Mac软件」→ `mac` → 被前缀兜底认成 `maccy`
//    · 「安装包合集」→ **空串** → `nk.startsWith('')` 恒为真 → 随机命中索引第一条（calibre）
//    一次污染了 5 条错配。修法是「保留汉字」+「前缀兜底只允许 ASCII 互比」+「长度守卫」。
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
const isAscii = (s) => /^[a-z0-9]+$/.test(s);
const byName = new Map();
const addName = (name, id) => {
  const k = norm(name);
  if (k && !byName.has(k)) byName.set(k, id);
};
for (const it of manifest) { addName(it.id, it.id); addName(it.name, it.id); addName(it.cn, it.id); }
for (const r of audit) { addName(r.id, r.id); addName(r.name, r.id); }
// 明确别名：网盘上的名字和项目 id 实在对不上的
const ALIAS = { mediainfogui: 'mediainfo-gui', tinirdm: 'tiny-rdm', loselessswitcher: 'lossless-switcher' };

function matchId(folder) {
  const k = norm(folder);
  if (k.length < 3) return null;              // 空串/纯符号先挡住 —— 前缀兜底对空串恒真
  if (ALIAS[k]) return ALIAS[k];
  if (byName.has(k)) return byName.get(k);
  // 退一步：前缀互相包含（`MediaInfo GUI` 之流已被别名覆盖，这里只是兜底）。
  // ⚠️ 只在 **ASCII 之间**比：含汉字的目录名基本是历史分类目录（跨平台软件 / 安装包合集…），
  //    拿它们做前缀匹配会把整片非目标目录误认成某个项目。
  if (!isAscii(k)) return null;
  for (const [nk, id] of byName) {
    if (isAscii(nk) && nk.length >= 4 && (nk.startsWith(k) || k.startsWith(nk))) return id;
  }
  return null;
}

// ── 用台账里的分享链接生成条目 ─────────────────────────────────────
const folders = Object.keys(ledger)
  .filter((k) => k.startsWith(`${ROOT_DIR}/`) && k.split('/').length === 2)
  .map((k) => ({ path: k, folder: k.split('/')[1], ...ledger[k] }));

const plan = [];
const unmatched = [];
for (const f of folders.sort((a, b) => a.folder.localeCompare(b.folder))) {
  const id = matchId(f.folder);
  if (!id) { unmatched.push(f); continue; }
  const value = `${f.link}${f.pwd ? `\n提取码：${f.pwd}` : ''}`;
  const existing = String(addr[id] || '').trim();
  const action = !existing ? 'fill' : existing === value ? 'same' : FORCE ? 'overwrite' : 'keep';
  plan.push({ id, folder: f.folder, value, action, existing });
}

// ── 报告 ────────────────────────────────────────────────────────────
const count = (a) => plan.filter((p) => p.action === a).length;
console.log(`══════ 同步分享链接 → 关键词回复表 ══════`);
console.log(`  台账里 ${ROOT_DIR}/ 下的产品目录：${folders.length} 个`);
console.log(`  对得上项目 id：${plan.length} 个　对不上：${unmatched.length} 个`);
console.log(`  待补 ${count('fill')}　已是最新 ${count('same')}　保留原值 ${count('keep')}　覆盖 ${count('overwrite')}`);
console.log(`  台账总分享数：${Object.keys(ledger).length}${DRY ? '　【dry-run，不写文件】' : ''}`);
console.log('');

for (const p of plan) {
  const mark = { fill: '＋', same: '＝', keep: '·', overwrite: '↻' }[p.action];
  const note = p.action === 'keep' ? '（已有值且与台账不同，保留；要覆盖加 --force）' : '';
  console.log(`  ${mark} ${p.folder.padEnd(18)} → ${p.id.padEnd(18)} ${p.value.split('\n')[0]}${note}`);
}
if (unmatched.length) {
  console.log('\n  ⚠️ 对不上项目 id 的（不会写进去）：');
  unmatched.forEach((f) => console.log(`     · ${f.path}`));
}

if (DRY) {
  console.log('\n（dry-run 结束，未写文件）');
  process.exit(0);
}

// ── 落盘 ────────────────────────────────────────────────────────────
let changed = 0;
for (const p of plan) {
  if (p.action === 'fill' || p.action === 'overwrite') {
    addr[p.id] = p.value;
    changed++;
  }
}
const out = {
  _说明: addr._说明 || '关键词自动回复用的网盘链接表。键 = 项目 id，值 = 网盘分享链接（含提取码）。',
  _来源: `由 scripts/sync-share-links.mjs 从 out/netdisk-shares.json 同步；同步时间 ${new Date().toISOString().slice(0, 19)}`,
  _留空说明: '没填的项目，回复里会显示 [网盘链接占位] —— 宁可显示占位也不误发空链接。',
  _热加载: '改完不用重启服务，服务按文件 mtime 自动重载。',
  ...Object.fromEntries(Object.entries(addr).filter(([k]) => !k.startsWith('_'))),
};
fs.writeFileSync(ADDR, JSON.stringify(out, null, 2), 'utf8');

const total = Object.keys(out).filter((k) => !k.startsWith('_')).length;
const withLink = Object.entries(out).filter(([k, v]) => !k.startsWith('_') && String(v).trim()).length;
console.log(`\n✅ 已写入 ${path.relative(ROOT, ADDR)}：本次更新 ${changed} 条`);
console.log(`   表内共 ${total} 条，其中有链接 ${withLink} 条`);
console.log('   服务会自动热加载，不用重启。');

// 顺手把「网盘文件夹名 → 项目 id」映射落盘：别的脚本（如补许可证全文）要用同一套映射，
// 各写一份迟早跑偏，所以以这里为准。
const MAP = path.join(ROOT, 'out', 'netdisk-map.json');
const map = {};
for (const p of plan) map[p.folder] = p.id;
fs.writeFileSync(
  MAP,
  JSON.stringify({ _说明: '网盘 软件/ 下的文件夹名 → 项目 id。由 sync-share-links.mjs 生成，勿手改。', generated_at: new Date().toISOString().slice(0, 19), map }, null, 2),
  'utf8',
);
console.log(`   另存映射 ${path.relative(ROOT, MAP)}（${Object.keys(map).length} 条）`);
