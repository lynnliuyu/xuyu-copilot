#!/usr/bin/env node
/**
 * GitHub 项目「授权 + 版本」体检器 —— 为「开源软件公众号」产出合规台账。
 *
 * ── 为什么不用 GitHub API 拿全部数据
 * 未认证的 api.github.com 只有 60 次/小时，跑几十个项目立刻被限流。
 * 所以这里**全部走免费取证通道**（普通网页 / raw 请求，不吃 API 配额）：
 *
 *   ① 许可证全文       raw.githubusercontent.com/<owner>/<repo>/HEAD/<候选文件名>
 *   ② 最新版本号       github.com/<owner>/<repo>/releases/latest 的 302 Location
 *   ③ 产物清单 + 体积   github.com/<owner>/<repo>/releases/expanded_assets/<tag>
 *   ④ 顶层文件树       github.com/<owner>/<repo> 页面内嵌 JSON（用来发现 assets/fonts/models）
 *   ⑤ Star 数          同上页面 stargazerCount
 *
 * 想要 GitHub 官方口径（spdx_id / archived / pushed_at）时加 `--api`，
 * 脚本会先查剩余配额，不够就跳过而不是失败。
 *
 * ── 用法
 *   npm run gh:audit                        # 全量体检
 *   npm run gh:audit -- --only maccy,stats  # 只跑指定 id
 *   npm run gh:audit -- --refresh           # 忽略缓存重抓
 *   npm run gh:audit -- --api               # 额外拉 API 元数据（配额感知）
 *   npm run gh:audit -- --list              # 只列清单不联网
 *
 * ── 产物
 *   out/gh-audit.json   台账（结构化，给脚本 / 前端用）
 *   out/gh-audit.md     体检报告（给人看）
 *   缓存目录             .cache/gh-audit/
 *
 * ── 授权分级（与 docs/开源软件公众号-运营方案.md 第 4 节一致）
 *   A 可打包   MIT / BSD / Apache-2.0 / ISC / MPL-2.0 / Unlicense / GPL / LGPL / AGPL
 *   B 可打包   CC0 / CC-BY / CC-BY-SA（需署名）
 *   C 不打包   CC-BY-NC / CC-BY-ND（禁商用 / 禁演绎）
 *   D 不打包   source-available：BSL / Elastic / SSPL / Commons Clause / PolyForm
 *   E 不打包   仓库无许可证文件 → 默认保留全部权利
 *   F 待拆分   代码是 A 类，但仓库内含 assets/fonts/models 等资源需单独核
 *   X 待人工   非开源 freeware（清单里 source=url 的条目）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'assets', 'free-software', 'manifest.json');
const CACHE_DIR = path.join(ROOT, '.cache', 'gh-audit');
const OUT_JSON = path.join(ROOT, 'out', 'gh-audit.json');
const OUT_MD = path.join(ROOT, 'out', 'gh-audit.md');

const UA = 'Mozilla/5.0 (compatible; gh-audit/1.0)';
const REQ_TIMEOUT_MS = Number(process.env.GH_AUDIT_TIMEOUT_MS || 25_000);
const GAP_MS = Number(process.env.GH_AUDIT_GAP_MS || 220);

// 缓存 TTL：许可证明细很少变，版本信息变得快
const TTL = {
  license: 7 * 24 * 3600_000,
  tree: 12 * 3600_000,
  release: 6 * 3600_000,
};

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

const ONLY = (argOf('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const REFRESH = has('--refresh');
const WANT_API = has('--api');
const LIST_ONLY = has('--list');

// ── 输出小工具（沿用仓库既有脚本的配色风格）────────────────────────
const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  m: (s) => `\x1b[35m${s}\x1b[0m`,
  cy: (s) => `\x1b[36m${s}\x1b[0m`,
};
const line = (s = '') => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP ──────────────────────────────────────────────────────────
async function req(url, { method = 'GET', manual = false } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: manual ? 'manual' : 'follow',
      headers: { 'User-Agent': UA, Accept: '*/*' },
      signal: ctl.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 取文本；失败返回 null（不抛）。
 * GitHub 的网页端会间歇性吐 502，所以 5xx / 网络抖动要重试；
 * 404 与 403/429 是明确答复或限流，重试没意义，直接返回。
 */
async function getText(url, { tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      await sleep(GAP_MS);
      const res = await req(url);
      if (res.ok) return await res.text();
      if (res.status === 404 || res.status === 403 || res.status === 429) return null;
    } catch {
      /* 网络抖动（含 502 / 超时）→ 重试 */
    }
    await sleep(600 * (i + 1));
  }
  return null;
}

/** 只取状态码 */
async function headStatus(url) {
  for (let i = 0; i < 3; i++) {
    try {
      await sleep(GAP_MS);
      const res = await req(url, { method: 'GET', manual: true });
      if (res.status && res.status < 500) return res.status;
    } catch {
      /* 重试 */
    }
    await sleep(600 * (i + 1));
  }
  return 0;
}

/** 拿到 302 的 Location（releases/latest → 版本号） */
async function getRedirect(url) {
  for (let i = 0; i < 3; i++) {
    try {
      await sleep(GAP_MS);
      const res = await req(url, { method: 'GET', manual: true });
      const loc = res.headers.get('location');
      if (loc) return loc;
      if (res.status === 404) return null; // 没有 release
    } catch {
      /* 重试 */
    }
    await sleep(600 * (i + 1));
  }
  return null;
}

// ── 缓存 ──────────────────────────────────────────────────────────
const cacheKey = (repo) => repo.replace('/', '__');

async function cached(repo, file, ttl, fn) {
  const p = path.join(CACHE_DIR, cacheKey(repo), file);
  if (!REFRESH && fs.existsSync(p)) {
    const age = Date.now() - fs.statSync(p).mtimeMs;
    if (age < ttl) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        /* 缓存坏了就重抓 */
      }
    }
  }
  const val = await fn();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(val, null, 2));
  return val;
}

// ── 授权识别 ──────────────────────────────────────────────────────
/**
 * 许可证文件名**兜底候选**（仅在拿不到文件树时使用）。
 * ⚠️ 真实文件名大小写千奇百怪 —— MonitorControl 用的是 `License.txt`，
 * 全大写 `LICENSE.txt` 在大小写敏感的 raw 路径上会 404，从而把一个 MIT 项目
 * 误判成「无许可证」。所以正常路径是**先从文件树读出真实名**（见 discoverLicenseFiles）。
 */
const LICENSE_FALLBACK = [
  'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE.rst',
  'License', 'License.md', 'License.txt',
  'COPYING', 'COPYING.md', 'COPYING.txt',
  'LICENSE-MIT', 'LICENSE-APACHE', 'LICENSE-APACHE-2.0',
  'LICENSE.GPL', 'LICENSE.LGPL',
  'LICENCE', 'LICENCE.md', 'Licence', 'Licence.md', 'Licence.txt',
];

/** 从文件树里挑出真正的许可证文件名（保留原始大小写） */
function discoverLicenseFiles(tree) {
  if (!tree) return null;
  const re = /^(licen[cs]e|copying)([-_.].*)?$/i;
  const hits = tree.filter((x) => x.type === 'file' && re.test(x.name)).map((x) => x.name);
  return hits.length ? hits : null;
}

/** 仓库顶层的第三方 / 资源线索 */
function discoverThirdParty(tree) {
  if (!tree) return { notice: [], thirdParty: [] };
  const isFile = (n) => /^(notice|third[-_.]?party[^/]*|copying[^/]*)$/i.test(n);
  const notice = tree.filter((x) => x.type === 'file' && isFile(x.name)).map((x) => x.name);
  const thirdParty = tree
    .filter((x) => x.type === 'directory' && /^(third[-_.]?party)(\/|$)/i.test(x.name))
    .map((x) => x.name);
  return { notice, thirdParty };
}

/**
 * 资源目录 → F 类信号（代码开源，但内置素材可能要单独授权）。
 *
 * ⚠️ 这里必须**只认强信号**。第一版把 `assets/` `resources/` `icons/` 也算进去，
 * 结果 9 个可打包项目里 7 个被误报成 F —— 那些目录装的是应用自己的 UI 资源，
 * 跟主协议走。误报一多，报告就没人看了。
 *
 * 强信号（真的可能夹带第三方授权）：vendor / third-party / licenses / fonts / models / weights
 * 弱信号（仅提示，不改分级）：assets / resources / icons / images / sounds / themes …
 */
const STRONG_DIR = [
  /^vendor(\/|$)/i,
  /^third[-_.]?party(\/|$)/i,
  /^licen[cs]es?(\/|$)/i,
  /^fonts?(\/|$)/i,
  /^models?(\/|$)/i,
  /^weights?(\/|$)/i,
];
const WEAK_DIR = /^(assets?|resources?|icons?|images?|media|sounds?|textures?|presets?|samples?|themes?|templates?|bin)(\/|$)/i;

function resourceSignal(tree, thirdParty) {
  if (!tree) return { risky: [], hints: [], notice: [] };
  const risky = tree
    .filter((x) => x.type === 'directory' && STRONG_DIR.some((re) => re.test(x.name)))
    .map((x) => x.name);
  const hints = tree
    .filter((x) => x.type === 'directory' && WEAK_DIR.test(x.name))
    .map((x) => x.name);
  const notice = [...(thirdParty?.notice || []), ...(thirdParty?.thirdParty || [])];
  return { risky, hints, notice };
}

/**
 * 从许可证正文识别协议。**顺序即优先级**：
 * 受限协议（D/C）必须排在宽松协议（A）之前 —— 否则一份「MIT + Commons Clause」
 * 会被误判成纯 MIT，这是最容易出事的误判。
 */
const RULES = [
  // D —— source-available，看着像开源但不是
  { tier: 'D', spdx: 'BUSL-1.1', re: /Business Source License/i },
  { tier: 'D', spdx: 'Elastic-2.0', re: /ELASTIC LICENSE/i },
  { tier: 'D', spdx: 'SSPL-1.0', re: /Server Side Public License/i },
  { tier: 'D', spdx: 'Commons-Clause', re: /Commons Clause/i },
  { tier: 'D', spdx: 'PolyForm', re: /PolyForm/i },
  { tier: 'D', spdx: 'Confluent-Community-1.0', re: /Confluent Community License/i },
  { tier: 'D', spdx: 'Redis-Source-Available', re: /Redis Source Available License/i },
  // C —— 禁商用 / 禁演绎
  { tier: 'C', spdx: 'CC-BY-NC', re: /Attribution-NonCommercial/i },
  { tier: 'C', spdx: 'CC-BY-ND', re: /NoDerivatives/i },
  // B —— 署名类
  { tier: 'B', spdx: 'CC0-1.0', re: /CC0 1\.0 Universal/i },
  { tier: 'B', spdx: 'CC-BY-SA-4.0', re: /Attribution-ShareAlike 4\.0/i },
  { tier: 'B', spdx: 'CC-BY-4.0', re: /Attribution 4\.0 International/i },
  // A —— 可再分发的开源协议
  { tier: 'A', spdx: 'AGPL-3.0', re: /GNU AFFERO GENERAL PUBLIC LICENSE/i },
  { tier: 'A', spdx: 'LGPL-3.0', re: /GNU LESSER GENERAL PUBLIC LICENSE[\s\S]{0,300}?Version 3/i },
  { tier: 'A', spdx: 'LGPL-2.1', re: /GNU LESSER GENERAL PUBLIC LICENSE[\s\S]{0,300}?Version 2\.1/i },
  { tier: 'A', spdx: 'GPL-3.0', re: /GNU GENERAL PUBLIC LICENSE[\s\S]{0,300}?Version 3/i },
  { tier: 'A', spdx: 'GPL-2.0', re: /GNU GENERAL PUBLIC LICENSE[\s\S]{0,300}?Version 2/i },
  { tier: 'A', spdx: 'Apache-2.0', re: /Apache License[\s\S]{0,120}?Version 2\.0/i },
  { tier: 'A', spdx: 'MPL-2.0', re: /Mozilla Public License Version 2\.0/i },
  { tier: 'A', spdx: 'Unlicense', re: /free and unencumbered software released into the public domain/i },
  { tier: 'A', spdx: 'ISC', re: /Permission to use, copy, modify, and(?:\/or)? distribute this software/i },
  { tier: 'A', spdx: 'BSD-3-Clause', re: /Redistribution and use in source and binary forms[\s\S]{0,1500}?Neither the name of/i },
  { tier: 'A', spdx: 'BSD-2-Clause', re: /Redistribution and use in source and binary forms/i },
  { tier: 'A', spdx: 'MIT', re: /MIT License|Permission is hereby granted, free of charge/i },
];

function detectLicense(text) {
  const head = text.slice(0, 4000);
  const hits = RULES.filter((r) => r.re.test(head)).map((r) => ({ tier: r.tier, spdx: r.spdx }));

  // 补漏：协议正文里没有标准体但文件头写了 SPDX-License-Identifier
  const spdxId = text.match(/SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+)/);
  if (spdxId) hits.push({ tier: tierOfSpdx(spdxId[1]), spdx: spdxId[1], fromSpdxTag: true });

  if (!hits.length) {
    // 认不出但文件存在 → 不要乐观地当成开源
    return { tier: 'E', spdx: 'UNKNOWN', note: '存在许可证文件但无法识别协议，需人工判读' };
  }
  // 取最严格的一档（D > C > B > A）
  const rank = { D: 0, C: 1, B: 2, A: 3 };
  hits.sort((a, b) => rank[a.tier] - rank[b.tier]);
  const picked = hits[0];
  return {
    tier: picked.tier,
    spdx: picked.spdx,
    all: [...new Set(hits.map((h) => h.spdx))],
  };
}

function tierOfSpdx(id) {
  const s = id.toUpperCase();
  if (/BUSL|SSPL|ELASTIC|POLYFORM|COMMONS/.test(s)) return 'D';
  if (/NC|ND/.test(s)) return 'C';
  if (/^CC0|^CC-BY/.test(s)) return 'B';
  return 'A';
}

/** 把清单里手写的 "GPL-3.0（开源）" 归一化 */
function normalizeDeclared(s) {
  if (!s) return { spdx: null, kind: 'unknown' };
  const raw = String(s);
  if (/免费软件|freeware|免费使用/i.test(raw) && !/GPL|MIT|Apache|BSD|MPL|AGPL|LGPL/i.test(raw)) {
    return { spdx: null, kind: 'freeware' };
  }
  const m = raw.match(/(AGPL|LGPL|GPL|Apache|BSD|MIT|MPL|ISC|Unlicense|CC[A-Z0-9.-]*)[\s-]*([0-9]+(?:\.[0-9]+)?)?/i);
  if (!m) return { spdx: null, kind: 'unknown' };
  const fam = m[1].toUpperCase();
  const ver = m[2] || '';
  const map = {
    MIT: 'MIT', APACHE: `Apache-${ver || '2.0'}`,
    AGPL: `AGPL-${ver || '3.0'}`, LGPL: `LGPL-${ver || '3.0'}`, GPL: `GPL-${ver || '3.0'}`,
  };
  if (map[fam]) return { spdx: map[fam], kind: 'oss' };
  if (fam.startsWith('BSD')) return { spdx: `BSD-${ver || '3'}-Clause`, kind: 'oss' };
  if (fam === 'MPL') return { spdx: `MPL-${ver || '2.0'}`, kind: 'oss' };
  if (fam === 'ISC') return { spdx: 'ISC', kind: 'oss' };
  if (fam === 'UNLICENSE') return { spdx: 'Unlicense', kind: 'oss' };
  if (fam.startsWith('CC')) return { spdx: `CC-${ver}`, kind: 'cc' };
  return { spdx: null, kind: 'unknown' };
}

// ── GitHub 页面解析 ────────────────────────────────────────────────
/** 从 "…" 位置起，用括号配对取出一个 JSON 数组 */
function extractJsonArray(src, from) {
  const start = src.indexOf('[', from);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(src.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function parseRepoPage(html) {
  const stars = Number((html.match(/"stargazerCount":(\d+)/) || [])[1] || 0);
  const archived = /This repository has been archived/i.test(html);
  const mark = html.indexOf('"tree":{"items":');
  const items = mark >= 0 ? extractJsonArray(html, mark) : null;
  const tree = Array.isArray(items)
    ? items.map((x) => ({ type: x.contentType, name: x.name }))
    : null;
  return { stars, archived, tree };
}

/**
 * expanded_assets 是纯 HTML 片段，按 download 路径切片再就近取体积。
 *
 * ⚠️ 坑（2026-10-09 修）：href 的形式是 `/releases/download/<tag>/<文件名>`，切完之后
 * `<tag>/` 是**留在结果里的**。早期版本直接拿它去拼 url，就会拼出
 * `.../releases/download/<tag>/<tag>/<文件名>` —— 多一层 tag 段 → **一律 404**。
 * GitHub 的资产文件名本身不含 `/`，所以「按已知 tag 精确剥、再退化为去首段」是安全的。
 */
function parseAssets(html, tag) {
  if (!html) return [];
  const out = [];
  const prefix = `${tag.tag}/`;
  const parts = html.split('/releases/download/');
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    const raw = seg.split('"')[0];
    if (!raw) continue;
    const rawName = raw.startsWith(prefix)
      ? raw.slice(prefix.length)
      : raw.includes('/')
        ? raw.slice(raw.indexOf('/') + 1)
        : raw;
    if (!rawName) continue;
    const tail = seg.slice(0, 3000);
    const size = tail.match(/>\s*([\d.]+)\s*(KB|MB|GB)\s*</i);
    out.push({
      name: decodeURIComponent(rawName),
      size: size ? `${size[1]} ${size[2].toUpperCase()}` : null,
      url: `https://github.com/${tag.owner}/${tag.repo}/releases/download/${tag.tag}/${rawName}`,
    });
  }
  const seen = new Set();
  return out.filter((a) => (seen.has(a.name) ? false : (seen.add(a.name), true)));
}

/**
 * 从产物名（+ 仓库顶层树兜底）推断平台与芯片 —— 公众号「支持系统」表格与网盘 L2 平台档靠它生成。
 *
 * ⚠️ 坑（2026-10-09 修）：早期版本只认 `\.app$`，于是 **`.app.zip` 匹配不上** ——
 * 「打包成 zip 的 mac 应用」这一整类被判 platforms 为空，连带 `gen-soft-dirs`
 * 生不出 `<软件名> - mac版/`，三层目录规范的第二层直接是空的。
 * 另：早期用 `macos` 裸词匹配，大写 `Mac` 与 `-mac-` 这类写法会被漏掉。
 */
function inferPlatforms(assets, tree = null) {
  const platforms = new Set();
  const arch = new Set();

  // 「词」匹配：前后必须是非字母数字，避免 `maccy` 被当成 mac、`darwin` 被当成 win
  // ⚠️ 返回的是**模式字符串**，不是 RegExp —— 直接插 RegExp 会把两侧 `/` 带进模式里，使整条规则失效
  const wordSrc = (w) => `(?:^|[^a-z0-9])${w}(?:[^a-z0-9]|$)`;
  const MAC_EXT = /\.(dmg|pkg)$|\.app(\.zip|\.tar\.gz|\.tgz)?$/;
  const MAC_WORD = new RegExp(`${wordSrc('mac')}|${wordSrc('macos')}|${wordSrc('osx')}|darwin`);
  const WIN_EXT = /\.(exe|msi|msix)$/;
  const WIN_WORD = new RegExp(
    `${wordSrc('windows')}|${wordSrc('win')}|${wordSrc('win32')}|${wordSrc('win64')}|win-(x64|arm64|ia32)`,
  );
  const LINUX_EXT = /\.(appimage|deb|rpm|snap|flatpak)$/;
  const LINUX_WORD = new RegExp(wordSrc('linux'));
  const ANDROID_EXT = /\.(apk|aab)$/;
  const ANDROID_WORD = new RegExp(wordSrc('android'));
  const INTEL_WORD = new RegExp(wordSrc('intel'));

  for (const a of assets) {
    const n = String(a.name).toLowerCase();
    if (MAC_EXT.test(n) || MAC_WORD.test(n)) platforms.add('macOS');
    if (WIN_EXT.test(n) || WIN_WORD.test(n)) platforms.add('Windows');
    if (LINUX_EXT.test(n) || LINUX_WORD.test(n)) platforms.add('Linux');
    if (ANDROID_EXT.test(n) || ANDROID_WORD.test(n)) platforms.add('Android');

    if (/aarch64|arm64|apple\s?silicon/.test(n)) arch.add('arm64');
    if (/x86_64|x86-64|x64|amd64/.test(n)) arch.add('x64');
    if (/universal/.test(n)) arch.add('universal');
    if (INTEL_WORD.test(n)) arch.add('x64');
  }

  // 产物名看不出平台时，用仓库顶层树兜底（Maccy 只发一个 `Maccy.app.zip`，但根目录有 .xcodeproj）
  if (platforms.size === 0 && Array.isArray(tree)) {
    const names = tree.map((x) => String(x.name).toLowerCase());
    if (names.some((x) => /\.(xcodeproj|xcworkspace)$/.test(x) || x === 'package.swift')) {
      platforms.add('macOS');
    }
    if (names.some((x) => /\.(sln|csproj)$/.test(x))) platforms.add('Windows');
  }

  return { platforms: [...platforms], arch: [...arch] };
}

// ── 单条体检 ──────────────────────────────────────────────────────
const TIER_VERDICT = {
  A: { action: 'PACK', cn: '可打包分发（附 LICENSE 全文 + 保留版权声明）' },
  B: { action: 'PACK', cn: '可打包分发（需署名 + 附协议链接）' },
  C: { action: 'HOLD', cn: '不打包：含禁商用 / 禁演绎条款，只做介绍与原链' },
  D: { action: 'REJECT', cn: '不打包：source-available，不是 OSI 开源协议' },
  E: { action: 'REJECT', cn: '不打包：未授予再分发权（默认保留全部权利）' },
  F: { action: 'MANUAL', cn: '代码可分发，但仓库内资源需逐项核验后再定' },
  X: { action: 'MANUAL', cn: '非开源 freeware：只介绍不打包，条款需人工核' },
};

async function auditItem(item) {
  const rec = {
    id: item.id,
    name: item.name,
    cn: item.cn,
    repo: item.repo || null,
    homepage: item.homepage || null,
    declared: item.license || null,
    source: item.source,
    note: item.note || null,
  };

  // ── 非 GitHub 来源（freeware）──────────────────────────────────
  if (!item.repo) {
    rec.tier = item.source === 'url' ? 'X' : null;
    rec.status = item.source === 'url' ? 'freeware' : 'needs_repo';
    rec.urlAlive = item.url ? await headStatus(item.url) : null;
    rec.url = item.url || null;
    const v = TIER_VERDICT[rec.tier] || { action: 'MANUAL', cn: '仓库地址待核实' };
    rec.action = v.action;
    rec.verdict = v.cn;
    return rec;
  }

  // ── ④ 顶层文件树 + ⑤ Star（必须先跑：许可证文件名要从树里读）──
  const page = await cached(item.repo, 'repo.json', TTL.tree, async () => {
    const html = await getText(`https://github.com/${item.repo}`);
    return html ? parseRepoPage(html) : null;
  });
  rec.stars = page?.stars || 0;
  rec.archived = page?.archived ?? null;
  rec.topLevel = page?.tree ? page.tree.map((x) => x.name) : null;

  const discovered = discoverLicenseFiles(page?.tree);
  const thirdParty = discoverThirdParty(page?.tree);

  // ── ① 许可证全文取证（优先按真实文件名取）────────────────────
  const lic = await cached(item.repo, 'license.json', TTL.license, async () => {
    const names = discovered?.length ? discovered : LICENSE_FALLBACK;
    const found = [];
    for (const f of names) {
      const txt = await getText(
        `https://raw.githubusercontent.com/${item.repo}/HEAD/${encodeURIComponent(f)}`,
      );
      if (txt && txt.length > 80) found.push({ file: f, text: txt });
    }
    return found;
  });
  rec.licenseFilesFound = discovered; // 树里看到的许可证文件名（null = 拿不到树）
  rec.thirdPartyFiles = thirdParty.notice;

  // ── ②③ 最新版本 + 产物 ────────────────────────────────────────
  const rel = await cached(item.repo, 'release.json', TTL.release, async () => {
    const loc = await getRedirect(`https://github.com/${item.repo}/releases/latest`);
    if (!loc) return { tag: null, assets: [] };
    const tag = decodeURIComponent(loc.replace(/.*\/tag\//, '').trim());
    const html = await getText(
      `https://github.com/${item.repo}/releases/expanded_assets/${encodeURIComponent(tag)}`,
    );
    const [owner, repo] = item.repo.split('/');
    return { tag, assets: parseAssets(html, { owner, repo, tag }) };
  });
  rec.latestTag = rel.tag;
  rec.assets = rel.assets;
  const inf = inferPlatforms(rel.assets || [], page?.tree);
  rec.platforms = inf.platforms;
  rec.arch = inf.arch;

  // ── 判定 ──────────────────────────────────────────────────────
  if (!lic.length) {
    rec.licenseFile = null;
    rec.detected = null;
    if (page?.tree) {
      // 文件树看到了、就是没有许可证文件 → 这才是「确证无授权」
      rec.tier = 'E';
      rec.status = 'no_license_file';
    } else {
      // 仓库页取不到 → 不能说人家没授权，只能标未核验
      rec.tier = null;
      rec.status = 'unverified';
    }
  } else {
    const per = lic.map((l) => ({ file: l.file, ...detectLicense(l.text) }));
    // 多个许可证文件时取最严格的一档（D > C > E > B > A）
    const rank = { D: 0, C: 1, E: 2, B: 3, A: 4 };
    per.sort((a, b) => rank[a.tier] - rank[b.tier]);
    const top = per[0];

    // ⚠️ all 必须是**所有许可证文件的并集**。早期版本只取排序第一份的 all，
    // 导致 Rust 项目常见的 LICENSE-MIT + LICENSE-APACHE 只报出 MIT，
    // 进而与清单登记的 Apache-2.0 产生假「不符」。
    const all = [...new Set(per.flatMap((p) => p.all || [p.spdx]))];

    rec.licenseFile = top.file;
    rec.licenseFiles = per.map((p) => p.file);
    rec.detected = { tier: top.tier, spdx: top.spdx, all, note: top.note || null };

    const res = resourceSignal(page?.tree, thirdParty);
    rec.resourceRisky = res.risky; // 强信号：vendor / fonts / models / licenses …
    rec.resourceHints = res.hints; // 弱信号：assets / resources / icons …（仅提示）
    rec.thirdPartyFiles = res.notice;

    const hasThirdPartyFile = res.notice.some((n) => /^third[-_.]?party/i.test(n));
    // 代码可打包 + 夹带第三方素材的可能 → F（需人工拆分），而不是直接放行
    rec.tier = top.tier === 'A' && (res.risky.length > 0 || hasThirdPartyFile) ? 'F' : top.tier;
    rec.status = 'ok';
  }

  // 声明 vs 实际
  const dec = normalizeDeclared(item.license);
  rec.declaredParsed = dec;
  if (rec.status === 'unverified') {
    rec.declaredMatch = 'unverifiable';
  } else if (dec.kind === 'freeware') {
    rec.declaredMatch = 'mismatch';
    rec.declaredNote = '清单按「免费软件」登记，但仓库是开源项目 —— 描述需更正';
  } else if (!dec.spdx) {
    rec.declaredMatch = 'unknown';
  } else if (rec.detected && sameLicense(dec.spdx, rec.detected.all)) {
    rec.declaredMatch = 'match';
  } else if (rec.detected) {
    rec.declaredMatch = 'mismatch';
    rec.declaredNote = `清单写 ${dec.spdx}，实际读出 ${rec.detected.all.join(' / ')}`;
  } else {
    rec.declaredMatch = 'unverifiable';
  }

  rec.obligation = rec.detected ? obligationOf(rec.detected.all) : null;

  const v = TIER_VERDICT[rec.tier] || {
    action: 'MANUAL',
    cn: rec.status === 'unverified' ? '仓库页取不到，本次未核验（重跑即可）' : '需人工判读',
  };
  rec.action = v.action;
  rec.verdict = v.cn;
  return rec;
}

/** GPL-3.0 与 GPL-3.0-only 视为一致；忽略 -only / -or-later 后缀 */
function sameLicense(a, list) {
  const norm = (s) => String(s).toLowerCase().replace(/-(only|or-later)$/, '').replace(/^bsd-(\d)-clause$/, 'bsd-$1-clause');
  const na = norm(a);
  return (list || []).some((x) => norm(x) === na || norm(x).startsWith(na) || na.startsWith(norm(x)));
}

/**
 * 分发义务 —— 「能不能分发」是第一步，「分发时要做到什么」才是真正会踩的坑。
 * GPL 家族只丢一个二进制出去是不合规的，必须附源码获取方式；这是最常见的疏漏。
 */
function obligationOf(spdxList) {
  const s = (spdxList || []).join(' ');
  if (/AGPL/i.test(s)) return 'AGPL：须提供完整源码（含网络服务场景向用户提供）';
  if (/LGPL/i.test(s)) return 'LGPL：须附源码获取方式 + 完整许可证文本';
  if (/GPL/i.test(s)) return 'GPL：须附源码获取方式（或源码）+ 完整许可证文本';
  if (/Apache/i.test(s)) return 'Apache-2.0：保留版权声明与许可证全文，仓库有 NOTICE 须一并携带';
  if (/MPL/i.test(s)) return 'MPL-2.0：保留许可证全文；被修改的 MPL 文件须公开源码';
  if (/^CC/i.test(s)) return 'CC 系：按要求署名 + 附协议链接';
  return '保留版权声明与许可证全文（随包放 LICENSE）';
}

// ── API 元数据（可选，配额感知）───────────────────────────────────
async function apiQuota() {
  try {
    const res = await req('https://api.github.com/rate_limit');
    const d = (await res.json()).resources.core;
    return { limit: d.limit, remaining: d.remaining, reset: d.reset };
  } catch {
    return { limit: 0, remaining: 0, reset: 0 };
  }
}

async function enrichWithApi(records, quota) {
  let left = quota.remaining;
  let used = 0, skipped = 0;
  for (const rec of records) {
    if (!rec.repo) continue;
    if (left <= 1) { rec.api = { skipped: 'rate_limit' }; skipped++; continue; }
    const data = await cached(rec.repo, 'api.json', TTL.tree, async () => {
      try {
        await sleep(GAP_MS);
        const res = await req(`https://api.github.com/repos/${rec.repo}`);
        if (!res.ok) return null;
        const j = await res.json();
        return {
          spdx: j.license?.spdx_id || null,
          archived: j.archived,
          pushedAt: j.pushed_at,
          stars: j.stargazers_count,
          createdAt: j.created_at,
          defaultBranch: j.default_branch,
        };
      } catch {
        return null;
      }
    });
    if (data) { rec.api = data; left--; used++; } else { skipped++; }
  }
  return { used, skipped, left };
}

// ── 报告 ──────────────────────────────────────────────────────────
function renderMd(records, meta) {
  const byTier = {};
  for (const r of records) (byTier[r.tier || '?'] ||= []).push(r);

  const L = [];
  L.push('# GitHub 项目授权与版本体检报告');
  L.push('');
  L.push(`> 生成时间：${new Date().toISOString().replace('T', ' ').slice(0, 19)}`);
  L.push(`> 数据源：\`${path.relative(ROOT, MANIFEST)}\` 共 ${records.length} 条`);
  L.push(`> 取证方式：raw LICENSE 全文 + 仓库页文件树 + releases 重定向（**不消耗 GitHub API 配额**）`);
  L.push('');

  L.push('## 一、结论汇总');
  L.push('');
  L.push('| 分级 | 含义 | 条目数 |');
  L.push('|---|---|---|');
  for (const [t, v] of Object.entries(TIER_VERDICT)) {
    if (byTier[t]?.length) L.push(`| **${t}** | ${v.cn} | ${byTier[t].length} |`);
  }
  L.push('');

  const pack = records.filter((r) => r.action === 'PACK');
  const manual = records.filter((r) => r.action === 'MANUAL');
  const reject = records.filter((r) => r.action === 'REJECT' || r.action === 'HOLD');
  L.push(`- ✅ **可直接打包** ${pack.length} 条`);
  L.push(`- ⚠️ **需人工处理** ${manual.length} 条（资源拆分 / freeware 条款）`);
  L.push(`- ❌ **不能打包** ${reject.length} 条`);
  L.push('');

  const mismatch = records.filter((r) => r.declaredMatch === 'mismatch');
  if (mismatch.length) {
    L.push(`### ⚠️ 清单登记与实际不符 ${mismatch.length} 条`);
    L.push('');
    L.push('| id | 清单写的 | 实际读出 | 说明 |');
    L.push('|---|---|---|---|');
    for (const r of mismatch) {
      L.push(`| ${r.id} | ${r.declared} | ${(r.detected?.all || ['—']).join(' / ')} | ${r.declaredNote || '—'} |`);
    }
    L.push('');
  }

  L.push('## 二、逐条明细');
  L.push('');
  L.push('| id | 项目 | 分级 | 实际协议（取证文件） | 版本 | 平台 | Star | 结论 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const r of records) {
    const mark = { PACK: '✅', MANUAL: '⚠️', REJECT: '❌', HOLD: '⛔' }[r.action] || '—';
    const licTxt = r.detected
      ? `${r.detected.all.join(' / ')} <br><sub>${r.licenseFile}</sub>`
      : r.status === 'no_license_file'
        ? '**无许可证文件**'
        : '—';
    const stars = r.stars ? Number(r.stars).toLocaleString('en-US') : '—';
    L.push(`| \`${r.id}\` | ${r.name} | ${r.tier || '—'} | ${licTxt} | ${r.latestTag || '—'} | ${(r.platforms || []).join('/') || '—'} | ${stars} | ${mark} ${r.verdict} |`);
  }
  L.push('');

  const freeware = records.filter((r) => r.tier === 'X');
  if (freeware.length) {
    L.push('## 三、非 GitHub 来源条目（授权无法自动核）');
    L.push('');
    L.push('这些条目在清单里登记为「免费软件」，没有 GitHub 仓库，**只能人工核条款**。');
    L.push('注意：**免费 ≠ 可再分发**。若其中实际是开源项目，建议在清单里补登 `repo` 字段，即可纳入自动体检。');
    L.push('');
    L.push('| id | 项目 | 清单登记 | 官方直链 | 建议 |');
    L.push('|---|---|---|---|---|');
    for (const r of freeware) {
      const hint = /BSD|MIT|GPL|Apache|MPL/i.test(r.declared || '')
        ? '⚠️ 登记里写着开源协议 —— **应补登 repo**，否则无法跟踪版本与协议变更'
        : '人工确认官方条款是否允许再分发';
      L.push(`| \`${r.id}\` | ${r.name} | ${r.declared || '—'} | HTTP ${r.urlAlive ?? '?'} | ${hint} |`);
    }
    L.push('');
  }

  L.push('## 四、需要处理的条目');
  L.push('');
  for (const r of [...manual, ...reject]) {
    L.push(`### ${r.name}（\`${r.id}\`） — ${r.tier} · ${r.action}`);
    L.push('');
    L.push(`- 仓库：${r.repo || '——（非 GitHub 来源）'}`);
    L.push(`- 清单登记：${r.declared || '—'}`);
    const actual = !r.repo
      ? '——（无仓库，未核验）'
      : r.detected
        ? r.detected.all.join(' / ')
        : r.licenseFile
          ? `存在 ${r.licenseFile} 但无法识别`
          : r.status === 'no_license_file'
            ? '**无许可证文件**'
            : '本次未取到（可重跑）';
    L.push(`- 实际读出：${actual}`);
    if (r.obligation) L.push(`- 分发义务：${r.obligation}`);
    if (r.resourceRisky?.length) L.push(`- ⚠️ 顶层**高风险目录**：\`${r.resourceRisky.join('` `')}\` —— 其中素材可能另有授权，需逐项确认`);
    if (r.thirdPartyFiles?.length) L.push(`- 第三方声明文件：\`${r.thirdPartyFiles.join('` `')}\``);
    if (r.resourceHints?.length) L.push(`- 资源目录（低风险提示，通常随主协议）：\`${r.resourceHints.join('` `')}\``);
    if (r.url) L.push(`- 官方直链状态：HTTP ${r.urlAlive ?? '?'} ${r.url}`);
    if (r.note) L.push(`- 清单备注：${r.note}`);
    L.push(`- 处理：${r.verdict}`);
    L.push('');
  }

  const packed = records.filter((r) => r.action === 'PACK');
  if (packed.length) {
    L.push('## 五、打包时的分发义务');
    L.push('');
    L.push('「能不能分发」只是第一步，这一步才是真正容易踩的 —— **GPL 家族只丢一个二进制出去是不合规的。**');
    L.push('');
    const groups = {};
    for (const r of packed) (groups[r.obligation || '—'] ||= []).push(r.id);
    L.push('| 分发义务 | 涉及条目 |');
    L.push('|---|---|');
    for (const [k, v] of Object.entries(groups)) {
      L.push(`| ${k} | ${v.map((x) => `\`${x}\``).join(' ')} |`);
    }
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push(`元信息：许可证文件命中 ${meta.licenseHits} 条 / 无许可证 ${meta.noLicense} 条 / 仓库页解析失败 ${meta.pageFail} 条`);
  if (meta.api) L.push(`API 补充：使用 ${meta.api.used} 次，跳过 ${meta.api.skipped} 条（剩余配额 ${meta.api.left}）`);
  L.push('');
  return L.join('\n');
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const all = manifest.items || [];
  const items = all.filter((x) => !ONLY.length || ONLY.includes(x.id));

  line('');
  line(c.b('══════ GitHub 授权 + 版本体检 ══════'));
  line(`  清单 ${items.length} / ${all.length} 条${ONLY.length ? c.dim(`（指定 ${ONLY.join(', ')}）`) : ''}`);
  line(c.dim(`  缓存 .cache/gh-audit/${REFRESH ? '（--refresh 已忽略缓存）' : ''}`));
  line('');

  if (LIST_ONLY) {
    for (const it of items) {
      line(`  ${it.repo ? c.g('·') : c.y('○')} ${String(it.id).padEnd(18)} ${String(it.name).padEnd(14)} ${c.dim(it.license || '')}`);
    }
    return;
  }

  const records = [];
  for (const it of items) {
    process.stdout.write(`  ${c.dim('▸')} ${String(it.id).padEnd(18)}`);
    let rec;
    try {
      rec = await auditItem(it);
    } catch (e) {
      rec = { id: it.id, name: it.name, repo: it.repo || null, status: 'error', error: String(e?.message || e), tier: null, action: 'MANUAL', verdict: '体检出错，需重跑' };
    }
    records.push(rec);
    const col = { PACK: c.g, MANUAL: c.y, REJECT: c.r, HOLD: c.m }[rec.action] || c.dim;
    line(`${col(String(rec.tier || '—').padEnd(2))} ${(rec.detected ? rec.detected.all.join('+') : rec.status || '').padEnd(22)} ${rec.latestTag ? c.cy(String(rec.latestTag).padEnd(14)) : ''.padEnd(14)} ${rec.declaredMatch === 'mismatch' ? c.y('← 清单不符') : ''}`);
  }

  // 可选：API 元数据
  let apiMeta = null;
  if (WANT_API) {
    const q = await apiQuota();
    line('');
    line(c.b(`  API 配额：${q.remaining}/${q.limit}，开始补充元数据…`));
    apiMeta = await enrichWithApi(records, q);
    line(c.dim(`  用了 ${apiMeta.used} 次，跳过 ${apiMeta.skipped} 条，剩余 ${apiMeta.left}`));
  }

  const meta = {
    licenseHits: records.filter((r) => r.detected).length,
    noLicense: records.filter((r) => r.status === 'no_license_file').length,
    pageFail: records.filter((r) => r.topLevel === null).length,
    api: apiMeta,
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    source: path.relative(ROOT, MANIFEST),
    count: records.length,
    summary: records.reduce((acc, r) => ((acc[r.action] = (acc[r.action] || 0) + 1), acc), {}),
    meta,
    items: records,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));
  fs.writeFileSync(OUT_MD, renderMd(records, meta));

  const s = payload.summary;
  line('');
  line(c.b('  ── 结论 ──'));
  line(`  ${c.g('✅ 可打包')}   ${s.PACK || 0}`);
  line(`  ${c.y('⚠️ 需人工')}   ${s.MANUAL || 0}`);
  line(`  ${c.r('❌ 不可打包')} ${(s.REJECT || 0) + (s.HOLD || 0)}   ${c.dim(`(REJECT ${s.REJECT || 0} / HOLD ${s.HOLD || 0})`)}`);
  line('');
  line(`  ${c.dim('→')} out/gh-audit.json`);
  line(`  ${c.dim('→')} out/gh-audit.md`);
  line('');
}

main().catch((e) => {
  console.error(c.r('\n体检失败：'), e);
  process.exit(1);
});
