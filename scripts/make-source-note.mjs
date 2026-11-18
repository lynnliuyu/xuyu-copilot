#!/usr/bin/env node
/**
 * 生成 GPL / AGPL 系条目的**随包合规文本**。
 *
 * ── 为什么需要它
 * GPL / AGPL 要求「分发二进制时，必须同时提供对应的完整源代码获取方式（或直接附源码）+ 完整许可证文本」。
 * 只丢一个安装包出去 = 可被投诉的实打实违规（见 `docs/开源软件公众号-首批选题与授权核验报告.md` 第五节）。
 * 本脚本把这件事**模板化**：每个条目一个目录，产出两份 txt，打包时直接拷进包里。
 *
 * ── 产出（每条）
 *   out/source-notes/<id>/SOURCE-获取方式.txt   ← GPL/AGPL 的源码提供义务声明（可省不得）
 *   out/source-notes/<id>/本包说明.txt           ← 通用随包说明（来源/协议/校验值/分发说明）
 *   out/source-notes/<id>/LICENSE-原文.txt       ← 上游许可证**正文留档**（从本地缓存抄录，见下）
 *   另产出 out/source-notes/INDEX.md             ← 汇总索引 + 待人工补录项
 *   检查模式产出 out/source-notes/CHECK.md        ← 打包前缺口清单（--check）
 *
 * ── 数据来源（全部本地既存文件，不联网）
 *   out/gh-audit.json                  → 协议、仓库、版本 tag、平台、芯片、许可证文件名
 *   out/free-software.json             → 已下载安装包的**真实 sha256**（拿不到就留占位）
 *   assets/free-software/manifest.json → 条目名称 / 中文说明 / asset 正则
 *   .cache/gh-audit/<owner>__<repo>/license.json → 上游许可证**正文**（gh-audit 抓取时落盘）
 *
 * ── 为什么要把许可证正文抄出来（LICENSE-原文.txt）
 * gh-audit 的取证正文只存在 `.cache/gh-audit/`，**7 天过期即被覆盖** → 一旦过期，「当时读到的
 * 是哪份许可证」就无从复现，是实打实的**留档缺口**。GPL/AGPL 要求随包附**完整许可证文本**，
 * 所以这里把缓存里的正文固化成随包文件（本地抄录，非重新联网取证）。
 * 缓存缺失时**不猜测、不编造** → 该条标 `LICENSE-原文.txt：缺（无本地缓存）`，重跑 `npm run gh:audit` 即可补上。
 *
 * ── 用法
 *   node scripts/make-source-note.mjs                     # 默认：自动挑出所有 GPL/AGPL 条目
 *   node scripts/make-source-note.mjs --only calibre,lulu # 只做指定条目
 *   node scripts/make-source-note.mjs --all               # 清单里全部条目（含 MIT/Apache，也会出本包说明）
 *   node scripts/make-source-note.mjs --no-license        # 不产出 LICENSE-原文.txt（只出两份 txt）
 *   node scripts/make-source-note.mjs --check             # 只做「打包前合规检查」，不写随包文本
 *   node scripts/make-source-note.mjs --list              # 只列出会处理哪些条目，不写文件
 *   node scripts/make-source-note.mjs --dry-run           # 打印内容但不落盘
 *   node scripts/make-source-note.mjs --out <目录>         # 改输出根目录（默认 out/source-notes）
 *   node scripts/make-source-note.mjs --date 2026-10-09   # 覆盖「核验日期」
 *
 * ⚠️ 本脚本**只读** out/ 与 manifest.json，只**新增**文件；不修改 package.json（归 W3），
 *    不触碰闲鱼 / 发布链路，不发任何对外请求（`--check` 同样只读本地）。
 * ⚠️ `--only` 会**只按子集重建 INDEX.md / CHECK.md**（条目目录本身不受影响）——
 *    与 `gh-audit --only` 同款行为：跑完 `--only` 后**必须再跑一次全量**恢复索引。
 * ⚠️ `--check` 退出码：有**阻塞项**（GPL 条目缺 SOURCE-获取方式.txt / 缺许可证正文留档）→ 退出码 1，否则 0。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT = path.join(ROOT, 'out', 'gh-audit.json');
const FETCHED = path.join(ROOT, 'out', 'free-software.json');
const MANIFEST = path.join(ROOT, 'assets', 'free-software', 'manifest.json');
const CACHE_ROOT = path.join(ROOT, '.cache', 'gh-audit');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, d = null) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] ?? d : d;
};

const ONLY = (() => {
  const v = valOf('--only');
  return v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : [];
})();

const DRY = has('--dry-run');
const LIST = has('--list');
const CHECK = has('--check');
const WITH_LICENSE = !has('--no-license');
const OUT_ROOT = path.resolve(ROOT, valOf('--out', path.join('out', 'source-notes')));
// 核验日期：默认取当天（本地时区）
const TODAY = valOf('--date') || new Date().toLocaleDateString('sv-SE'); // sv-SE → YYYY-MM-DD
const CONTACT = '<你的联系方式>'; // 打包前替换成真实联系方式（文章底部 / 公众号后台都会给）

/**
 * 平台兜底：gh-audit 的平台是从产物名推断的，个别条目（产物只有 .zip）会推断为空。
 * 这里人工补登，避免随包说明里「支持系统」写成空白。留空表示真的没识别出来。
 * ⚠️ 只登**确凿**的：产物是 `.app.zip` / `.zip`（内含 .app）且项目本身只发 macOS 版。
 */
const PLATFORM_OVERRIDE = {
  'lossless-switcher': ['macOS'], // LosslessSwitcher2.app.zip
  'alt-tab': ['macOS'], // AltTab-11.9.0.zip（内含 AltTab.app）
  ice: ['macOS'], // Ice.zip（菜单栏管理，仅 macOS）
  maccy: ['macOS'], // Maccy.app.zip
  fsnotes: ['macOS'], // FSNotes_v7.3.5.zip
  xcodesapp: ['macOS'], // Xcodes.zip
  openinterminal: ['macOS'], // OpenInTerminal.zip
};

/**
 * 已知的**内置第三方组件**（F 级资源核查结论，见
 * `docs/开源软件公众号-F级资源核查.md`）。
 * 作用：把「核查过了、但打包的人不知道该补什么」这件事固化成随包文本里的一段清单。
 * ⚠️ 主协议**不覆盖**这些组件；各自许可证正文上游仓库通常不附（只有 UPSTREAM 版本记录），
 *    须从上游逐字取回后放入同一目录。
 */
const VENDOR_NOTES = {
  'alt-tab': {
    components: [
      {
        name: 'Sparkle',
        version: '2.9.1（2026-05-12）',
        license: 'MIT（另含 EXTERNAL LICENSES 段：bsdiff = BSD-2、sais-lite = MIT 风格、Ed25519 = zlib 风格、SUSignatureVerifier.m = BSD-2 —— 均为宽松许可）',
        upstream: 'https://github.com/sparkle-project/Sparkle',
        need: '随包补 LICENSE-Sparkle.txt（含 EXTERNAL LICENSES 段全文）',
      },
      {
        name: 'App Center SDK（CrashReporter.xcframework）',
        version: 'appcenter-4.3.0 + PLCrashReporter-1.11.1',
        license: 'MIT（Copyright (c) Microsoft Corporation）',
        upstream: 'https://github.com/microsoft/appcenter-sdk-apple',
        need: '随包补 LICENSE-AppCenterSDK.txt（MIT 全文 + 版权声明）',
      },
      {
        name: 'ShortcutRecorder（lwouis fork）',
        version: 'alt-tab-current@52c6273',
        license: 'CC BY 4.0（仅 README 徽章声明；⚠️ 上游 fork 仓库内无 LICENSE 文件）',
        upstream: 'https://github.com/lwouis/ShortcutRecorder',
        need: '随包补 LICENSE-ShortcutRecorder.txt + 保留署名（CC BY 的 BY 义务）',
      },
    ],
    cautions: [
      '本包**必须原样分发**，不得拆包提取内部资源再单独分发 —— `resources/SF-Pro-Text-Regular.otf` 是 Apple 的 SF Pro 字体，字体文件本身不可再分发。',
    ],
  },
};

/** SPDX / 简称 → 许可证正式名称 */
const LICENSE_NAMES = {
  'GPL-3.0': 'GNU General Public License v3.0（GNU 通用公共许可证 第 3 版）',
  'GPL-3.0-only': 'GNU General Public License v3.0（GNU 通用公共许可证 第 3 版）',
  'GPL-3.0-or-later': 'GNU General Public License v3.0 or later（第 3 版或更新）',
  'GPL-2.0': 'GNU General Public License v2.0（GNU 通用公共许可证 第 2 版）',
  'GPL-2.0-only': 'GNU General Public License v2.0（GNU 通用公共许可证 第 2 版）',
  'GPL-2.0-or-later': 'GNU General Public License v2.0 or later（第 2 版或更新）',
  'AGPL-3.0': 'GNU Affero General Public License v3.0（GNU Affero 通用公共许可证 第 3 版）',
  'AGPL-3.0-only': 'GNU Affero General Public License v3.0（GNU Affero 通用公共许可证 第 3 版）',
  'AGPL-3.0-or-later': 'GNU Affero General Public License v3.0 or later（第 3 版或更新）',
  'LGPL-2.1': 'GNU Lesser General Public License v2.1',
  'LGPL-3.0': 'GNU Lesser General Public License v3.0',
  MIT: 'MIT License',
  'Apache-2.0': 'Apache License 2.0',
  'BSD-2-Clause': 'BSD 2-Clause "Simplified" License',
  'BSD-3-Clause': 'BSD 3-Clause "New" or "Revised" License',
  'MPL-2.0': 'Mozilla Public License 2.0',
  ISC: 'ISC License',
  'CC0-1.0': 'Creative Commons Zero v1.0 Universal',
  UNKNOWN: '未识别（需人工确认）',
};

/** 是否属 GPL / AGPL 家族（决定要不要出 SOURCE-获取方式.txt） */
const isGplFamily = (spdx) => /^(A?GPL|LGPL)/i.test(String(spdx || ''));

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readJsonSafe = (p) => (fs.existsSync(p) ? readJson(p) : null);

// ── 载入数据 ────────────────────────────────────────────────────────────────
if (!fs.existsSync(AUDIT)) {
  console.error(`✗ 找不到体检产物：${path.relative(ROOT, AUDIT)}，请先跑 npm run gh:audit`);
  process.exit(1);
}
const audit = readJson(AUDIT);
const manifest = readJsonSafe(MANIFEST);
const fetched = readJsonSafe(FETCHED);

const fetchedById = new Map();
for (const r of fetched?.items ?? []) if (r?.id) fetchedById.set(r.id, r);
const manifestById = new Map();
for (const r of manifest?.items ?? []) if (r?.id) manifestById.set(r.id, r);

// ── 选条目 ──────────────────────────────────────────────────────────────────
let targets = audit.items;
if (ONLY.length) {
  const miss = ONLY.filter((id) => !audit.items.some((x) => x.id === id));
  if (miss.length) console.warn(`⚠️ 体检产物里没有这些 id：${miss.join(', ')}`);
  targets = audit.items.filter((x) => ONLY.includes(x.id));
} else if (!has('--all')) {
  // 默认：GPL / AGPL 家族（源码提供义务最需要随包落实的那批）
  targets = audit.items.filter((x) => isGplFamily(x.detected?.spdx));
}
targets = [...targets].sort((a, b) => String(a.id).localeCompare(String(b.id)));

// ── 工具 ────────────────────────────────────────────────────────────────────
const line = (s = '') => console.log(s);
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
/** 相对路径展示；超出项目根（--out 指到别处）时直接给绝对路径，避免 `../../..` */
const rel = (p) => {
  const r = path.relative(ROOT, p);
  return r.startsWith('..') ? p : r;
};

/** 从产物名推断支持平台（gh-audit 未识别时的兜底） */
function inferPlatforms(item) {
  if (item.platforms?.length) return item.platforms;
  if (PLATFORM_OVERRIDE[item.id]) return PLATFORM_OVERRIDE[item.id];
  const names = (item.assets ?? []).map((a) => String(a.name).split('/').pop().toLowerCase());
  const set = new Set();
  for (const n of names) {
    if (/\.dmg$|\.app\.zip$|macos|darwin|osx/.test(n)) set.add('macOS');
    if (/\.(exe|msi)$|windows|win(32|64)/.test(n)) set.add('Windows');
    if (/\.(appimage|deb|rpm)$|linux/.test(n)) set.add('Linux');
    if (/\.apk$|android/.test(n)) set.add('Android');
  }
  return [...set];
}

/** 「本包安装文件」信息：优先用已下载的真实记录 */
function packageInfo(id, item) {
  const f = fetchedById.get(id);
  if (f && f.status === 'downloaded' && f.file) {
    return {
      file: f.file,
      version: f.version || item.latestTag || '',
      sha256: f.sha256 || null,
      verified: f.verified,
      download_url: f.download_url || null,
      local: f.local || null,
      source: 'out/free-software.json（本机已下载并算出 sha256）',
    };
  }
  return { file: null, version: item.latestTag || '', sha256: null, verified: null, source: '（尚未下载，校验值留占位）' };
}

const shaLine = (sha, file) =>
  sha
    ? `sha256 = ${sha}`
    : `sha256 = （下载后填入；应与你手上安装包的实测值一致）`;

const shaExplain = (sha, pkg) => {
  if (sha) {
    const v = pkg.verified === true ? '，且与官方 Release 公布的摘要一致' : pkg.verified === false ? '，⚠️ 与官方摘要不一致，请复核' : '';
    return `本值由本机对该安装文件实测得出${v}。核验方式（macOS）：shasum -a 256 "<文件名>"`;
  }
  return '下载安装包后在终端执行 shasum -a 256 "<文件名>" 即可得到，填入本行。';
};

/**
 * 从本地缓存抄录上游许可证**正文**。
 * 缓存文件由 gh-audit 抓取时落盘（`.cache/gh-audit/<owner>__<repo>/license.json`），本函数**不联网**。
 * 返回 { files:[{file,text}], source, mtime }；source ∈ cache / no-cache / no-repo / bad-cache
 */
function licenseTexts(item) {
  if (!item.repo) return { files: [], source: 'no-repo' };
  const p = path.join(CACHE_ROOT, String(item.repo).replace('/', '__'), 'license.json');
  if (!fs.existsSync(p)) return { files: [], source: 'no-cache' };
  let arr;
  try {
    arr = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { files: [], source: 'bad-cache' };
  }
  const files = (Array.isArray(arr) ? arr : [])
    .filter((f) => f && f.file && f.text)
    .map((f) => ({ file: String(f.file), text: String(f.text) }));
  // 把「体检认定的主许可证文件」排在最前，其余按文件名排序（多许可证项目需要全部留档）
  const primary = item.licenseFile;
  files.sort((a, b) => (b.file === primary) - (a.file === primary) || a.file.localeCompare(b.file));
  return { files, source: 'cache', mtime: fs.statSync(p).mtime };
}

/** 许可证正文留档文本（LICENSE-原文.txt） */
function licenseArchive(item, lic) {
  const repo = item.repo ? `https://github.com/${item.repo}` : item.homepage || '(未登记)';
  const spdx = item.detected?.spdx || 'UNKNOWN';
  const licFull = LICENSE_NAMES[spdx] || spdx;
  const head = `================================================================================
LICENSE-原文  ·  许可证正文留档
================================================================================
项目名称：${item.name}${item.cn ? `（${item.cn}）` : ''}
原始仓库：${repo}
识别协议：${spdx} — ${licFull}
留档文件：${lic.files.map((f) => f.file).join(' / ')}（共 ${lic.files.length} 个）
取证来源：上游仓库 raw 通道，由 scripts/gh-audit.mjs 抓取后落盘 .cache/gh-audit/
取证时间：${lic.mtime ? lic.mtime.toISOString() : '（未知）'}
留档时间：${TODAY}
用途：本文件是**上游许可证原文的留档**，随安装包一并分发。
      GPL/AGPL 要求分发二进制时同时提供**完整许可证文本**；此处即该文本。
      多许可证项目（如 COPYING + LICENSE）此处**全部收录**，不筛选，避免漏掉附属条款。

⚠️ 正文为上游原文，任何情况下**不要编辑**本文件；若内容与上游不一致，以上游仓库为准。
================================================================================

`;
  const body = lic.files
    .map(
      (f, i) => `--------------------------------------------------------------------------------
【文件 ${i + 1}/${lic.files.length}】${f.file}　（${Buffer.byteLength(f.text, 'utf8')} 字节）
--------------------------------------------------------------------------------
${f.text.replace(/\s*$/, '')}
`,
    )
    .join('\n');
  const foot = `
================================================================================
（留档结束。全部正文逐字抄录自上游仓库，未做任何修改。）
================================================================================
`;
  return head + body + foot;
}

/** 内置第三方组件段（无登记时返回空串） */
function vendorSection(item) {
  const v = VENDOR_NOTES[item.id];
  if (!v?.components?.length) return '';
  const body = v.components
    .map(
      (c, i) => `${i + 1}) ${c.name}
   版本：${c.version}
   许可证：${c.license}
   上游：${c.upstream}
   → ${c.need}`,
    )
    .join('\n\n');
  const cautions = v.cautions?.length ? `\n⚠️ 注意：\n${v.cautions.map((c) => `   · ${c}`).join('\n')}\n` : '\n';
  return `--------------------------------------------------------------------------------
内置第三方组件（本次已核，随包须一并处理）
--------------------------------------------------------------------------------
本软件包内置了以下第三方组件，各有独立授权，**不在**主协议覆盖范围内：

${body}
${cautions}   · 上述组件许可证正文**上游仓库未随附**（仓库内只有 \`UPSTREAM\` 版本记录），
     须从上面各自的「上游」地址逐字取回后放入本目录。

`;
}

// ── 文本模板 ────────────────────────────────────────────────────────────────
function sourceNote(item, pkg, lic = { files: [] }) {
  const spdx = item.detected?.spdx || 'UNKNOWN';
  const licFull = LICENSE_NAMES[spdx] || `${spdx}（见同目录许可证文件）`;
  const repo = item.repo ? `https://github.com/${item.repo}` : item.homepage || '(未登记)';
  const tag = item.latestTag || '(未识别)';
  const isAgpl = /^AGPL/i.test(spdx);
  const licFile = item.licenseFile || 'LICENSE';
  const tarball = item.repo && tag !== '(未识别)' ? `https://github.com/${item.repo}/archive/refs/tags/${tag}.tar.gz` : null;
  const zipball = item.repo && tag !== '(未识别)' ? `https://github.com/${item.repo}/archive/refs/tags/${tag}.zip` : null;
  const licLine = lic.files?.length
    ? `许可证全文：同目录 LICENSE-原文.txt（逐字抄录自上游 ${lic.files.map((f) => f.file).join(' / ')}，共 ${lic.files.length} 份，${lic.files.reduce((n, f) => n + Buffer.byteLength(f.text, 'utf8'), 0)} 字节）`
    : `许可证全文：⚠️ **同目录缺失** —— 须补齐（详见索引 INDEX.md 的待人工补录）`;

  return `================================================================================
SOURCE-获取方式  ·  源代码获取说明
================================================================================
本软件是自由软件（Free Software），依据 GNU ${isAgpl ? 'Affero ' : ''}通用公共许可证分发。
按该许可证的要求，本处在分发可执行程序（安装包）的同时，向接收者提供**完整对应的
源代码获取方式**，并附上许可证全文。

--------------------------------------------------------------------------------
一、项目信息
--------------------------------------------------------------------------------
项目名称：${item.name}（${item.cn || ''}）
原始仓库：${repo}
许可证文件：${licLine}

--------------------------------------------------------------------------------
二、对应版本
--------------------------------------------------------------------------------
本包对应的上游版本（tag）：${tag}
${pkg.file ? `本包文件名：${pkg.file}` : '本包文件名：（见同目录安装文件）'}

--------------------------------------------------------------------------------
三、源码获取方式（三选一，均可，推荐第 1 种）
--------------------------------------------------------------------------------
1) 直接下载对应版本的源码归档（无需 git，最快）
${tarball ? `   ${tarball}
   ${zipball}` : '   （仓库地址或版本未识别，请按下面第 3 种方式获取，或联系我们）'}

2) 使用 git 克隆并切到同一版本
${item.repo ? `   git clone ${repo}.git
   cd ${String(item.repo).split('/').pop()}
   git checkout ${tag}` : '   （仓库地址未登记）'}

3) 官方网站 / 发行页
   ${item.homepage || repo}
   ${item.repo ? `   Releases 页：${repo}/releases` : ''}

   ★ 若以上任一链接失效，或你希望我们**直接随包附带完整源码**，
     请联系 ${CONTACT}，我们将在合理时间内**免费**提供对应源码。

--------------------------------------------------------------------------------
四、分发声明
--------------------------------------------------------------------------------
· 本包为上游官方发布的**未经修改**的安装文件，我们未改动其任何字节。
· 我们不添加任何额外限制，任何人均可依许可证条款自由使用、研究、修改与再分发。
· 本处不是本软件的作者，也不提供任何担保（详见许可证全文的免责条款）。
· 著作权归原作者所有。如觉得好用，请前往仓库点 Star 支持：
  ${repo}
${isAgpl ? `
   ⚠️ 本软件使用 AGPL（而非 GPL）：除上述义务外，AGPL 另有一条**网络服务**条款 ——
      若有人把它改造为对外提供网络服务，须向该服务的用户提供修改后的源码。
      本处仅按上游官方包原样分发、未作任何修改，故不涉及该情形，但仍在此如实说明。
` : ''}
--------------------------------------------------------------------------------
五、核验记录
--------------------------------------------------------------------------------
核验日期：${TODAY}
识别协议：${spdx} — ${licFull}
核验工具：scripts/gh-audit.mjs（读取仓库许可证全文 + releases 重定向）
核验方式：以仓库内 ${licFile} 正文为准，非依据清单登记
校验值（本包安装文件）：${shaLine(pkg.sha256, pkg.file)}
  ${shaExplain(pkg.sha256, pkg)}

================================================================================
（本文件随安装包一并提供，请勿删除。删除即视为未履行 GPL/AGPL 源码提供义务。）
================================================================================
`;
}

function packReadme(item, pkg, lic = { files: [] }) {
  const spdx = item.detected?.spdx || 'UNKNOWN';
  const licFull = LICENSE_NAMES[spdx] || `${spdx}（见同目录许可证文件）`;
  const repo = item.repo ? `https://github.com/${item.repo}` : item.homepage || '(未登记)';
  const plats = inferPlatforms(item);
  // 芯片：能从产物名读出来就直接写。读不出来时**不写「未自动识别」** ——
  // 这是给下载者看的随包文件，自曝工具短板只会降低可信度；按平台给一句有用的话。
  const arch = item.arch?.length
    ? item.arch.join(' / ')
    : plats.includes('macOS')
      ? '官方未在产物名标注芯片；macOS 端应用通常为通用二进制（Intel 与 Apple 芯片均可运行），以官方发布说明为准'
      : '官方未在产物名标注芯片，请以官方发布说明为准';
  const needSource = isGplFamily(spdx);
  const licFiles = (lic.files || []).map((f) => f.file).join(' / ');
  const licClause = lic.files?.length
    ? `· 同目录**已包含**许可证全文：\`LICENSE-原文.txt\`（逐字抄录自上游 ${licFiles}，未做任何修改）。`
    : `· ⚠️ 同目录**缺少**许可证全文 —— 打包前必须补齐：跑 \`npm run gh:audit\` 后重跑本脚本，
   或从上游仓库取 ${item.licenseFile || 'LICENSE'} 原文放入本目录。`;

  return `================================================================================
本包说明
================================================================================
项目名称：${item.name}
中文用途：${item.cn || ''}
原始仓库：${repo}
官方网站：${item.homepage || repo}
授权协议：${licFull}
识别标识：${spdx}

对应版本：${pkg.version || item.latestTag || '（未识别）'}
本包文件名：${pkg.file || '（见同目录安装文件）'}
本包来源：上游官方发布的安装文件，**未做任何修改**（未改字节、未去签名、未夹带）
支持系统：${plats.length ? plats.join(' / ') : '未自动识别，请以官方发布页为准'}
支持架构：${arch}

--------------------------------------------------------------------------------
校验值
--------------------------------------------------------------------------------
${shaLine(pkg.sha256, pkg.file)}
  ${shaExplain(pkg.sha256, pkg)}

--------------------------------------------------------------------------------
分发说明
--------------------------------------------------------------------------------
· 本包依据上述许可证分发，著作权归原作者所有，本处仅为转载/整理。
· 原项目地址：${repo}
  好用请前往支持原作者（Star / 捐赠 / 反馈问题）。
· 本处与原作者**无从属关系**，未获得其背书；软件按「原样」提供，不提供任何担保。
${needSource ? `· 本软件属 GPL/AGPL 系：依许可证要求，本包**同时提供**源码获取方式 ——
  见同目录《SOURCE-获取方式.txt》，**该文件不可删除、不可省略**。
${licClause}` : licClause}
· 如权利人认为本分发不当，请联系 ${CONTACT}，我们将在收到通知后**立即下架**
  并停止一切形式的再分发（详见《合规与下架流程》）。

${vendorSection(item)}--------------------------------------------------------------------------------
核验记录
--------------------------------------------------------------------------------
核验日期：${TODAY}
核验工具：scripts/gh-audit.mjs（读仓库许可证正文 + 版本重定向，未消耗 GitHub API 配额）
备注：协议以仓库内 ${item.licenseFile || 'LICENSE'} 正文为准；清单登记仅作参考。
================================================================================
`;
}

// ── 打包前合规检查（--check）：只读，不写随包文本 ────────────────────────────
if (CHECK) {
  const seen = new Set();
  const rows = [];
  for (const it of audit.items) {
    const needSource = isGplFamily(it.detected?.spdx);
    // 检查范围：GPL/AGPL 家族（必须齐）＋ 已经生成过目录的条目（顺手验一遍）
    const dir = path.join(OUT_ROOT, it.id);
    const generated = fs.existsSync(dir);
    if (!needSource && !generated) continue;
    seen.add(it.id);

    const pkg = packageInfo(it.id, it);
    const lic = licenseTexts(it);
    const hasSourceFile = fs.existsSync(path.join(dir, 'SOURCE-获取方式.txt'));
    const hasReadme = fs.existsSync(path.join(dir, '本包说明.txt'));
    const hasLic = fs.existsSync(path.join(dir, 'LICENSE-原文.txt'));
    const blockers = [];
    const warns = [];

    if (needSource && !hasSourceFile) blockers.push('缺 SOURCE-获取方式.txt');
    if (!hasReadme) blockers.push('缺 本包说明.txt');
    if (!pkg.sha256) warns.push('sha256 待填（安装包未下载）');
    if (!it.latestTag) warns.push('版本 tag 未识别');
    if (!inferPlatforms(it).length) warns.push('支持系统未识别');

    const licArchiveOk = hasLic || lic.files.length > 0;
    const licState = hasLic ? 'file' : lic.files.length ? 'cache' : 'none';
    if (needSource && it.repo && !licArchiveOk) {
      blockers.push('缺许可证正文留档（缓存缺失 → 重跑 npm run gh:audit）');
    } else if (needSource && !it.repo && !hasLic) {
      blockers.push('缺许可证正文留档（非 GitHub 来源，需人工放置）');
    } else if (needSource && lic.files.length === 0 && hasLic) {
      warns.push('正文留档存在但缓存在效性未知');
    }
    if (lic.files.length > 1) warns.push(`多许可证文件 ${lic.files.length} 个（已全部收录）`);
    const vendor = VENDOR_NOTES[it.id];
    if (vendor?.components?.length) warns.push(`内置第三方组件 ${vendor.components.length} 个 → 随包须另补各自许可证（见本包说明.txt）`);
    if (it.detected?.declaredMatch === 'mismatch') blockers.push(`清单登记与实际协议不一致（${it.detected?.spdx}）`);

    rows.push({ id: it.id, name: it.name, spdx: it.detected?.spdx || 'UNKNOWN', needSource, generated, hasSourceFile, hasReadme, licState, licFiles: lic.files.map((f) => f.file), sha: !!pkg.sha256, blockers, warns });
  }

  // 孤儿目录：out/source-notes 里有、但体检产物里没有的（条目被删/改名后的残留）
  const orphans = fs.existsSync(OUT_ROOT)
    ? fs.readdirSync(OUT_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && !seen.has(d.name)).map((d) => d.name)
    : [];

  const blocked = rows.filter((r) => r.blockers.length);
  const md = [];
  md.push('# 随包合规文本 · 打包前检查（--check）');
  md.push('');
  md.push(`> 检查时间：${new Date().toISOString()}　·　工具：\`node scripts/make-source-note.mjs --check\``);
  md.push(`> 范围：GPL/AGPL 家族全部条目 + 已生成目录的条目，共 **${rows.length}** 条`);
  md.push('');
  md.push(`## 结论：**${blocked.length ? `${blocked.length} 条阻塞` : '无阻塞'}**，${rows.filter((r) => r.warns.length).length} 条有提示`);
  md.push('');
  md.push('| id | 协议 | SOURCE | 本包说明 | 许可证正文 | 校验值 | 判定 |');
  md.push('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const mark = (ok) => (ok ? '✅' : '❌');
    const licMark = r.licState === 'file' ? '✅ 已落盘' : r.licState === 'cache' ? '🔄 可生成' : '❌';
    md.push(`| \`${r.id}\` | ${r.spdx} | ${r.needSource ? mark(r.hasSourceFile) : '—'} | ${mark(r.hasReadme)} | ${licMark} | ${r.sha ? '✅' : '⚠️'} | ${r.blockers.length ? `⛔ ${r.blockers.join('；')}` : '通过'} |`);
  }
  md.push('');
  md.push('> 图例：**SOURCE / 本包说明** ✅=文件已在 `out/source-notes/<id>/`；**许可证正文** ✅已落盘=`LICENSE-原文.txt` 文件存在，🔄可生成=文件未落盘但本地缓存有正文（重跑生成即可），❌=两处都没有；**校验值** ⚠️=仍是占位符（安装包未下载），不阻塞但打包后须补。');
  md.push('');
  if (blocked.length) {
    md.push('## ⛔ 阻塞项（打包前必须解决）');
    md.push('');
    for (const r of blocked) md.push(`- **\`${r.id}\`**：${r.blockers.join('；')}`);
    md.push('');
  }
  const warnRows = rows.filter((r) => r.warns.length);
  if (warnRows.length) {
    md.push('## ⚠️ 提示项（不阻塞，但打包后须补）');
    md.push('');
    for (const r of warnRows) md.push(`- \`${r.id}\`：${r.warns.join('；')}${r.licFiles.length ? `　〔正文文件：${r.licFiles.join(', ')}〕` : ''}`);
    md.push('');
  }
  if (orphans.length) {
    md.push('## 说明：目录存在但已不在体检产物中');
    md.push('');
    md.push(`以下目录在 \`${rel(OUT_ROOT)}/\` 里，但 \`out/gh-audit.json\` 已无对应 id（多为条目改名/移除的残留，**本脚本不删除任何文件**）：`);
    md.push('');
    for (const o of orphans) md.push(`- \`${o}\``);
    md.push('');
  }

  line('');
  line('══════ 打包前合规检查（--check）══════');
  line(`  范围：${rows.length} 条${ONLY.length ? `（指定 ${ONLY.join(', ')}）` : has('--all') ? '（--all）' : '（GPL/AGPL 家族 + 已生成目录）'}`);
  for (const r of rows) {
    const tag = r.blockers.length ? red('⛔') : r.warns.length ? yellow('⚠️') : green('✅');
    const detail = r.blockers.length ? r.blockers.join('；') : r.warns.join('；');
    line(`  ${tag} ${String(r.id).padEnd(20)} ${String(r.spdx).padEnd(12)} ${detail || '通过'}`);
  }
  if (orphans.length) line(dim(`  · 另有 ${orphans.length} 个目录已不在体检产物中（不删除）：${orphans.join(', ')}`));
  line('');
  line(`  汇总：${rows.length} 条　阻塞 ${blocked.length ? red(String(blocked.length)) : green('0')}　提示 ${yellow(String(warnRows.length))}`);
  if (!DRY) {
    fs.mkdirSync(OUT_ROOT, { recursive: true });
    fs.writeFileSync(path.join(OUT_ROOT, 'CHECK.md'), md.join('\n'));
    line(dim(`  报告：${rel(path.join(OUT_ROOT, 'CHECK.md'))}`));
  }
  line('');
  process.exit(blocked.length ? 1 : 0);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
line('');
line('══════ 生成随包合规文本（SOURCE-获取方式 / 本包说明）══════');
line(`  体检产物：${path.relative(ROOT, AUDIT)}（${audit.count} 条，生成于 ${audit.generatedAt}）`);
line(`  待处理  ：${targets.length} 条${ONLY.length ? `（指定 ${ONLY.join(', ')}）` : has('--all') ? '（--all）' : '（默认 = GPL/AGPL 家族）'}`);
line(`  核验日期：${TODAY}    输出根：${rel(OUT_ROOT)}`);
line(`  许可证  ：${WITH_LICENSE ? '同时产出 LICENSE-原文.txt（逐字抄录本地缓存，不联网）' : '已禁用（--no-license）'}`);
line('');

if (!targets.length) {
  line(yellow('  没有匹配的条目 —— 检查 --only 的 id 是否拼错，或用 --all。'));
  line('');
  process.exit(0);
}

if (LIST) {
  for (const it of targets) {
    const spdx = it.detected?.spdx || 'UNKNOWN';
    const gpl = isGplFamily(spdx) ? green('GPL系→需 SOURCE 文件') : dim('非 GPL 系');
    line(`  · ${String(it.id).padEnd(20)} ${String(it.name).padEnd(18)} ${String(spdx).padEnd(12)} ${gpl}`);
  }
  line('');
  process.exit(0);
}

const written = [];
const manual = [];

for (const it of targets) {
  const pkg = packageInfo(it.id, it);
  const needSource = isGplFamily(it.detected?.spdx);
  const dir = path.join(OUT_ROOT, it.id);
  const files = [];

  if (!DRY) fs.mkdirSync(dir, { recursive: true });

  // 许可证正文留档（从本地缓存抄录；缓存缺失时不猜测，只记录缺口）——先算，供另两份文本引用
  let lic = { files: [], source: 'skipped' };
  if (WITH_LICENSE) {
    lic = licenseTexts(it);
    if (lic.files.length) {
      const p3 = path.join(dir, 'LICENSE-原文.txt');
      if (!DRY) fs.writeFileSync(p3, licenseArchive(it, lic));
      files.push('LICENSE-原文.txt');
    } else {
      manual.push(`${it.id}：许可证正文未留档（${lic.source === 'no-repo' ? '非 GitHub 来源' : '本地缓存缺失 → 跑 npm run gh:audit'}）`);
    }
  }

  if (needSource) {
    const p = path.join(dir, 'SOURCE-获取方式.txt');
    if (!DRY) fs.writeFileSync(p, sourceNote(it, pkg, lic));
    files.push('SOURCE-获取方式.txt');
  }
  const p2 = path.join(dir, '本包说明.txt');
  if (!DRY) fs.writeFileSync(p2, packReadme(it, pkg, lic));
  files.push('本包说明.txt');
  files.sort((a, b) => (a === 'LICENSE-原文.txt' ? -1 : b === 'LICENSE-原文.txt' ? 1 : a.localeCompare(b)));

  const flags = [];
  if (pkg.sha256) flags.push(pkg.verified === false ? red('校验⚠️不一致') : green('含实测 sha256'));
  else { flags.push(yellow('sha256 待填')); manual.push(`${it.id}：安装包未下载 → 校验值占位`); }
  if (!it.latestTag) manual.push(`${it.id}：版本 tag 未识别 → 源码链接留空`);
  if (!inferPlatforms(it).length) manual.push(`${it.id}：支持系统未识别 → 需人工补`);
  if (WITH_LICENSE) flags.push(lic.files.length ? green(`正文×${lic.files.length}`) : red('正文缺'));

  line(`  ${green('✅')} ${String(it.id).padEnd(20)} ${files.join(' + ').padEnd(52)} ${flags.join(' ')}`);
  written.push({ id: it.id, name: it.name, spdx: it.detected?.spdx || 'UNKNOWN', tag: it.latestTag || '', needSource, dir: path.relative(ROOT, dir), files, sha256: pkg.sha256, licFiles: lic.files.map((f) => f.file), licSource: lic.source });
}

// ── 索引 ────────────────────────────────────────────────────────────────────
const idxLines = [];
idxLines.push('# 随包合规文本 · 索引');
idxLines.push('');
idxLines.push(`> 生成时间：${new Date().toISOString()}　·　核验日期：${TODAY}　·　工具：\`scripts/make-source-note.mjs\``);
idxLines.push(`> 数据源：\`out/gh-audit.json\`（协议/仓库/tag）+ \`out/free-software.json\`（实测 sha256）`);
idxLines.push('');
idxLines.push('## 内容');
idxLines.push('');
idxLines.push(`共 **${written.length}** 条，其中 **${written.filter((w) => w.needSource).length}** 条属 GPL/AGPL 家族（必须带 \`SOURCE-获取方式.txt\`）。`);
idxLines.push('');
idxLines.push('| id | 名称 | 协议 | 对应版本 | 随包文件 | 许可证正文留档 | 校验值 |');
idxLines.push('|---|---|---|---|---|---|---|');
for (const w of written) {
  const licCell = w.licSource === 'skipped' ? '（未生成）' : w.licFiles.length ? `✅ ${w.licFiles.join(' / ')}` : `❌ 缺（${w.licSource}）`;
  idxLines.push(`| \`${w.id}\` | ${w.name} | ${w.spdx} | ${w.tag || '—'} | ${w.needSource ? 'SOURCE + 本包说明' : '本包说明'} | ${licCell} | ${w.sha256 ? `\`${String(w.sha256).slice(0, 12)}…\`` : '待填'} |`);
}
idxLines.push('');
idxLines.push('## 打包时怎么用');
idxLines.push('');
idxLines.push('1. 把 `out/source-notes/<id>/` 里的**全部 txt** 连同安装包一起打进交付目录；');
idxLines.push('2. **许可证正文已随产出**（`LICENSE-原文.txt`，逐字抄录自上游仓库，多许可证项目全部收录）——');
idxLines.push('   若某条标注「缺（no-cache）」，先跑 `npm run gh:audit` 补缓存再重跑本脚本；');
idxLines.push('3. 若 `本包说明.txt` 里 sha256 仍是占位符，下载后实测填入；');
idxLines.push('4. 把 `' + CONTACT + '` 替换成真实联系方式（文章底部与公众号后台一致）；');
idxLines.push('5. 打包后跑一次 `node scripts/make-source-note.mjs --check` 作为最后一道闸门（见 `CHECK.md`）。');
idxLines.push('');
if (manual.length) {
  idxLines.push('## ⚠️ 待人工补录');
  idxLines.push('');
  for (const m of [...new Set(manual)]) idxLines.push(`- ${m}`);
  idxLines.push('');
}
if (!DRY) {
  fs.writeFileSync(path.join(OUT_ROOT, 'INDEX.md'), idxLines.join('\n'));
}

line('');
line(`${'汇总'}：生成 ${green(String(written.length))} 条（GPL/AGPL ${green(String(written.filter((w) => w.needSource).length))} 条）；待人工补录 ${yellow(String(new Set(manual).size))} 项`);
if (!DRY) line(dim(`  输出：${rel(OUT_ROOT)}/　索引：${rel(path.join(OUT_ROOT, 'INDEX.md'))}`));
line('');

if (DRY) {
  const demo = targets.find((t) => isGplFamily(t.detected?.spdx)) || targets[0];
  const demoLic = WITH_LICENSE ? licenseTexts(demo) : { files: [] };
  line(dim(`──── DRY-RUN 预览：${demo.id}/SOURCE-获取方式.txt ────`));
  line(sourceNote(demo, packageInfo(demo.id, demo), demoLic));
  line(dim(`──── DRY-RUN 预览：${demo.id}/LICENSE-原文.txt（头 600 字）────`));
  line(demoLic.files.length ? licenseArchive(demo, demoLic).slice(0, 600) + '\n…' : dim('  （无本地缓存正文）'));
}
