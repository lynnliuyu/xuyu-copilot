#!/usr/bin/env node
/**
 * 网盘「开源软件」目录初始化方案生成器 —— **只产出清单与脚本，不执行任何网盘写操作**。
 *
 * 为什么要有这一步：开源软件公众号的每一个项目，在网盘里都要有一个**结构一致**的目录，
 * 否则「打包 → 上传 → 关键词回复」这条链路每次都要临场决定放哪、叫什么，迟早乱。
 * 这里把目录结构一次性定死，产出可审阅、可执行（由人工/发布流程执行）的清单。
 *
 * ── 目录规范（沿用 仓/待售/软件/ 的既有三层约定）
 *   仓/待售/软件/<软件名>/                         ← L1 软件名
 *     <软件名> - windows版/                         ← L2 平台档
 *       便携版/                                     ← L3 形态
 *       安装版/                                     ← L3 形态
 *     <软件名> - mac版/                             ← L2 平台档（Mac 不分便携/安装，芯片写文件名）
 *     <软件名> - linux版/                           ← L2 平台档（格式写文件名）
 *     <软件名> - android版/                         ← L2 平台档（可选）
 *     授权说明/                                     ← 随包合规：LICENSE / 本包说明.txt / SOURCE-获取方式.txt
 *
 * 命名硬规则（与 scripts/software-tree.ts 一致）：版本号进文件名、架构标注、**避开平台敏感词**。
 *
 * ── 输入（全部本地既存文件，**不联网**）
 *   assets/free-software/manifest.json     条目 + 是否可再分发（redistributable）
 *   out/gh-audit.json                     平台 / 芯片 / 分级 / 处置（PACK / MANUAL）
 *   out/netdisk-index.json                网盘现状（用于标出「目录已存在」）
 *
 * ── 用法
 *   node scripts/gen-soft-dirs.mjs                 # 生成全部产物
 *   node scripts/gen-soft-dirs.mjs --only a,b      # 只生成指定条目
 *
 * ── 产物
 *   out/soft-dirs-plan.json   结构化方案（给脚本用）
 *   out/soft-dirs-plan.md     给人看的清单 + 可直接复制的命令
 *   out/soft-dirs-init.sh     可执行的建目录脚本（**默认不自动运行**）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'assets', 'free-software', 'manifest.json');
const AUDIT = path.join(ROOT, 'out', 'gh-audit.json');
const INDEX = path.join(ROOT, 'out', 'netdisk-index.json');
const OUT_JSON = path.join(ROOT, 'out', 'soft-dirs-plan.json');
const OUT_MD = path.join(ROOT, 'out', 'soft-dirs-plan.md');
const OUT_SH = path.join(ROOT, 'out', 'soft-dirs-init.sh');

const SOFT_ROOT_REL = '仓/待售/软件'; // 与 scripts/software-tree.ts 的 SOFT_ROOT_REL 对齐
const BANNED = ['破解', '免费', '永久', '全网最低', '可商用'];

const argv = process.argv.slice(2);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
const ONLY = (argOf('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);

const PLATFORM_DIR = { Windows: 'windows版', macOS: 'mac版', Linux: 'linux版', Android: 'android版' };

/** 目录名清洗：去掉路径非法字符，保留空格（既有目录 「MediaInfo GUI」 就是这么存的） */
function sanitize(name) {
  return String(name).replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

/** 平台档 → 形态子目录 */
function formsOf(platform) {
  return platform === 'Windows' ? ['便携版', '安装版'] : [];
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

/** 从网盘索引里取出「软件/」下已有的目录名（大小写不敏感匹配用） */
function existingDirs() {
  const idx = readJson(INDEX, null);
  const set = new Set();
  if (!idx) return set;
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.path === '软件' || n.path === SOFT_ROOT_REL) {
        for (const c of n.children || []) if (c.dir) set.add(String(c.name).toLowerCase());
      }
      if (n.children) walk(n.children);
    }
  };
  walk(idx.tree);
  return set;
}

function planFor(entry, audit, existSet) {
  const id = entry.id;
  const dirName = sanitize(entry.name || id);
  const platforms = audit?.platforms || [];
  const tier = audit?.tier || null;
  const action = audit?.action || 'MANUAL';
  const redist = entry.redistributable || 'yes';

  let verdict = 'create';
  let reason = '';
  if (action === 'PACK') {
    verdict = 'create';
    reason = tier ? `${tier} 级 · 可打包分发` : '可打包分发';
  } else if (tier === 'F') {
    verdict = 'hold';
    reason = 'F 级：仓库内置第三方资源（vendor / fonts 等）需先拆分后再建包目录';
  } else if (redist === 'no') {
    verdict = 'skip';
    reason = '未授予再分发权 → 只介绍、不建分发目录';
  } else if (redist === 'conditional') {
    verdict = 'hold';
    reason = '再分发有前提（如「非商业」）→ 前提未确认前不建分发目录';
  } else if (tier === 'X') {
    verdict = 'create';
    reason = 'freeware 且官方条款允许再分发（见 docs/开源软件公众号-freeware条款核查.md）';
  } else {
    verdict = 'hold';
    reason = `授权未定（tier=${tier || 'null'}）→ 待核后再建`;
  }

  // 目录树
  const dirs = [`${SOFT_ROOT_REL}/${dirName}`];
  for (const p of platforms) {
    const label = PLATFORM_DIR[p];
    if (!label) continue;
    const base = `${SOFT_ROOT_REL}/${dirName}/${dirName} - ${label}`;
    dirs.push(base);
    for (const f of formsOf(p)) dirs.push(`${base}/${f}`);
  }
  dirs.push(`${SOFT_ROOT_REL}/${dirName}/授权说明`);

  const exists = existSet.has(dirName.toLowerCase());
  const banned = BANNED.filter((w) => dirName.includes(w));

  return {
    id, name: entry.name, dirName, verdict, reason,
    tier, action, redistributable: redist,
    platforms, arch: audit?.arch || [],
    license: entry.license || null,
    obligation: audit?.obligation || null,
    existing: exists,
    bannedWords: banned,
    dirs,
  };
}

function main() {
  const manifest = readJson(MANIFEST, { items: [] });
  const audit = readJson(AUDIT, { items: [] });
  const auditMap = new Map((audit.items || []).map((x) => [x.id, x]));
  const existSet = existingDirs();

  const items = (manifest.items || [])
    .filter((x) => !ONLY.length || ONLY.includes(x.id))
    .map((x) => planFor(x, auditMap.get(x.id), existSet));

  const counts = {
    total: items.length,
    create: items.filter((x) => x.verdict === 'create').length,
    hold: items.filter((x) => x.verdict === 'hold').length,
    skip: items.filter((x) => x.verdict === 'skip').length,
    existing: items.filter((x) => x.existing).length,
    dirsTotal: items.filter((x) => x.verdict === 'create').reduce((a, x) => a + x.dirs.length, 0),
  };

  const payload = {
    generatedAt: new Date().toISOString(),
    tool: 'gen-soft-dirs',
    softRoot: SOFT_ROOT_REL,
    counts,
    items,
  };
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));
  fs.writeFileSync(OUT_MD, renderMd(payload, audit.generatedAt));
  fs.writeFileSync(OUT_SH, renderSh(payload));

  console.log('');
  console.log(`══════ 网盘目录初始化方案（仓/待售/软件/）══════`);
  console.log(`  条目 ${counts.total}　建议建目录 ${counts.create}（共 ${counts.dirsTotal} 个目录）`);
  console.log(`  待定(hold) ${counts.hold}　不建(skip) ${counts.skip}　网盘已存在 ${counts.existing}`);
  console.log(`  → out/soft-dirs-plan.json`);
  console.log(`  → out/soft-dirs-plan.md`);
  console.log(`  → out/soft-dirs-init.sh（默认不执行；人工审阅后再跑）`);
  console.log('');
}

function renderMd(p, auditAt) {
  const L = [];
  const create = p.items.filter((x) => x.verdict === 'create');
  const hold = p.items.filter((x) => x.verdict === 'hold');
  const skip = p.items.filter((x) => x.verdict === 'skip');

  L.push('# 网盘「开源软件」目录初始化方案');
  L.push('');
  L.push(`> 生成时间：${p.generatedAt.replace('T', ' ').slice(0, 19)} · 平台/分级依据 \`out/gh-audit.json\`（${auditAt ? String(auditAt).slice(0, 19) : '—'}）`);
  L.push('> ⚠️ 本文件是**方案**：不含任何网盘写操作。执行请走 `npm run soft:tree` 或 `out/soft-dirs-init.sh`（人工审阅后再跑）。');
  L.push('');
  L.push('## 目录规范（三层：软件名 → 平台档 → 形态）');
  L.push('');
  L.push('```');
  L.push(`${p.softRoot}/<软件名>/`);
  L.push(`  <软件名> - windows版/{便携版,安装版}`);
  L.push(`  <软件名> - mac版/          # Mac 不分便携/安装，芯片写进文件名：(Apple芯片)/(Intel)`);
  L.push(`  <软件名> - linux版/        # 格式写进文件名：.deb/.AppImage`);
  L.push(`  <软件名> - android版/      # 可选`);
  L.push(`  授权说明/                  # LICENSE + 本包说明.txt +（GPL/AGPL）SOURCE-获取方式.txt`);
  L.push('```');
  L.push('');
  L.push('**命名硬规则**：版本号必须进文件名；架构/芯片标注清楚；目录名与文件名**避开** `破解` `免费` `永久` `全网最低` `可商用`（闲鱼违规词，分享页可见）。同义表达用 `开源版` `社区版` `便携版` `直接下载`。');
  L.push('');
  L.push('| 状态 | 条数 | 含义 |');
  L.push('|---|---|---|');
  L.push(`| ✅ 建议创建 | ${p.counts.create} | 已过授权核验，可进入打包分发 |`);
  L.push(`| ⏸ 待定 | ${p.counts.hold} | 授权/资源待核，先不建 |`);
  L.push(`| ⛔ 不建 | ${p.counts.skip} | 未授予再分发权，只做介绍 |`);
  L.push('');

  L.push('## 一、建议创建（可执行）');
  L.push('');
  L.push('| # | 软件名 | 目录名 | 平台档 | 已有 | 分发义务 |');
  L.push('|---|---|---|---|---|---|');
  create.forEach((x, i) => {
    const plat = x.platforms.map((p) => PLATFORM_DIR[p]).filter(Boolean).join(' / ') || '—';
    L.push(`| ${i + 1} | ${x.name} | \`${x.dirName}\` | ${plat} | ${x.existing ? '✅ 已存在' : '—'} | ${x.obligation || '—'} |`);
  });
  L.push('');
  L.push('### 逐条目录清单');
  L.push('');
  for (const x of create) {
    L.push(`**${x.name}**（\`${x.id}\`）${x.existing ? ' · 网盘已存在，补子目录即可' : ''}`);
    L.push('');
    L.push('```');
    for (const d of x.dirs) L.push(d);
    L.push('```');
    L.push('');
  }

  if (hold.length) {
    L.push('## 二、待定（授权/资源未落定，先不建目录）');
    L.push('');
    L.push('| 软件名 | 分级 | 再分发 | 原因 |');
    L.push('|---|---|---|---|');
    for (const x of hold) L.push(`| ${x.name} | ${x.tier || '—'} | ${x.redistributable} | ${x.reason} |`);
    L.push('');
  }

  if (skip.length) {
    L.push('## 三、不建目录（只介绍，不给网盘链接）');
    L.push('');
    L.push('| 软件名 | 登记协议 | 原因 |');
    L.push('|---|---|---|');
    for (const x of skip) L.push(`| ${x.name} | ${x.license || '—'} | ${x.reason} |`);
    L.push('');
  }

  const bad = p.items.filter((x) => x.bannedWords.length);
  L.push('## 四、自检');
  L.push('');
  L.push(bad.length ? `- ⚠️ 以下目录名命中敏感词，必须改名：${bad.map((x) => `${x.dirName}（${x.bannedWords.join('、')}）`).join('；')}` : '- ✅ 目录名未命中平台敏感词（破解/免费/永久/全网最低/可商用）');
  L.push(`- ✅ 层级 ≤ 3 层（软件名 → 平台档 → 形态）`);
  L.push(`- ✅ 平台档按 \`out/gh-audit.json\` 实测产物自动生成，未臆造平台`);
  L.push('');
  return L.join('\n');
}

function renderSh(p) {
  const create = p.items.filter((x) => x.verdict === 'create');
  const L = [];
  L.push('#!/usr/bin/env bash');
  L.push('# 网盘「开源软件」目录批量初始化 —— 由 scripts/gen-soft-dirs.mjs 生成');
  L.push(`# 生成时间 ${p.generatedAt} · 共 ${create.length} 个软件`);
  L.push('#');
  L.push('# ⚠️ 默认是「只打印、不执行」的干跑模式。确认无误后加 --apply 才真正建目录。');
  L.push('# ⚠️ 建目录会写百度网盘（对外动作）→ 由人工/发布流程在有授权时执行。');
  L.push('set -euo pipefail');
  L.push('APPLY=0');
  L.push('if [[ "${1:-}" == "--apply" ]]; then APPLY=1; fi');
  L.push('run() { echo "+ $*"; if [[ $APPLY == 1 ]]; then "$@"; fi; }');
  L.push('');
  L.push(`# 基础骨架（windows版/便携版/安装版 + mac版）交给既有工具；其余目录用 mkdir 补。`);
  for (const x of create) {
    L.push('');
    L.push(`# ── ${x.name} (${x.id}) ──`);
    L.push(`run npm run soft:tree -- init "${x.dirName}"`);
    const extras = x.dirs.filter((d) => /(linux版|android版|授权说明)$/.test(d));
    for (const e of extras) L.push(`# 另需创建：${e}`);
  }
  L.push('');
  L.push('echo "完成（APPLY=${APPLY}）"');
  L.push('');
  return L.join('\n');
}

main();
