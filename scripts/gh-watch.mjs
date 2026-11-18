#!/usr/bin/env node
/**
 * GitHub 项目「版本巡检器」—— 为「开源软件公众号」兑现「持续跟踪版本」的承诺。
 *
 * ── 它做什么
 * 读「台账」里记着的版本号（`out/gh-audit.json` 的 `latestTag`），
 * 再去线上问一次每个仓库的最新版本，两边一对比，产出**待更新清单**。
 *
 * ── 为什么还要单独写一个（gh-audit 不是已经有 latestTag 吗）
 * gh-audit 是「体检器」：每次跑都会把 latestTag 刷成**当下最新**，所以它天然「永远是最新」，
 * 没法回答「我上次记录/发布的版本，现在过时了没有」。
 * 巡检器的语义是**记账 vs 现况的差**：台账（`out/gh-audit.json` 或 `--ledger` 指定的文件）
 * 里的版本是「我手上这一版」，线上是新版就该更新。发布新版后重跑一次 gh-audit 刷新台账，
 * 差异即归零 —— 这就是「台账驱动」的闭环。
 *
 * ── 免费取证通道（**不消耗 GitHub API 配额**，与 scripts/gh-audit.mjs 同源）
 *   ① 最新版本号     github.com/<repo>/releases/latest 的 302 Location → /releases/tag/<tag>
 *   ② 兜底取版本     latest 落空（如最新版被标 pre-release）时，回退读 /releases 页首个 tag
 *   ③ 新版本产物     github.com/<repo>/releases/expanded_assets/<tag>（**仅对「待更新」条目抓**）
 *
 * ── 用法
 *   npm run gh:watch                      # 全量巡检
 *   npm run gh:watch -- --only appflowy,obs-studio
 *   npm run gh:watch -- --refresh         # 忽略缓存重抓
 *   npm run gh:watch -- --ledger out/gh-audit.json
 *   npm run gh:watch -- --concurrency 6   # 并发（默认 5，越大越容易被 GitHub 限速）
 *   npm run gh:watch -- --json            # 只吐 JSON 摘要（给自动化用）
 *   npm run gh:watch -- --no-assets       # 待更新条目也跳过产物抓取
 *
 * ── 产物
 *   out/gh-watch.json   结构化：items[] + updates[] + counts（给脚本 / 前端 / 自动化读）
 *   out/gh-watch.md     给人看：待更新清单在最上面
 *   缓存目录             .cache/gh-watch/（版本 TTL 默认 2h，可用 GH_WATCH_TTL_MS 覆盖）
 *
 * ── 状态口径
 *   update      台账版本 ≠ 线上版本 → **需要更新**
 *   up-to-date  归一化后一致
 *   variant     归一化后一致、只是写法不同（v1.2 vs 1.2 / release-1.2 vs 1.2）→ 视为最新
 *   no-record   台账里没有版本号（首次纳入跟踪）
 *   no-release  线上取不到任何 release（仓库没发版 / 页面取不到）
 *   error       重试后仍取数失败（GitHub 网页端间歇 502 是常态，重跑即可）
 *   no-repo     非 GitHub 来源（freeware），不参与版本巡检
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'assets', 'free-software', 'manifest.json');
const DEFAULT_LEDGER = path.join(ROOT, 'out', 'gh-audit.json');
const CACHE_DIR = path.join(ROOT, '.cache', 'gh-watch');
const OUT_JSON = path.join(ROOT, 'out', 'gh-watch.json');
const OUT_MD = path.join(ROOT, 'out', 'gh-watch.md');

const UA = 'Mozilla/5.0 (compatible; gh-watch/1.0)';
const REQ_TIMEOUT_MS = Number(process.env.GH_WATCH_TIMEOUT_MS || 25_000);
const GAP_MS = Number(process.env.GH_WATCH_GAP_MS || 220);
const TTL_MS = Number(process.env.GH_WATCH_TTL_MS || 2 * 3600_000); // 版本缓存默认 2 小时

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

const ONLY = (argOf('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const REFRESH = has('--refresh');
const JSON_ONLY = has('--json');
const NO_ASSETS = has('--no-assets');
const LEDGER = path.resolve(ROOT, argOf('--ledger') || DEFAULT_LEDGER);
const CONCURRENCY = Math.max(1, Math.min(12, Number(argOf('--concurrency') || process.env.GH_WATCH_CONCURRENCY || 5)));

// ── 输出小工具 ────────────────────────────────────────────────────
const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  m: (s) => `\x1b[35m${s}\x1b[0m`,
  cy: (s) => `\x1b[36m${s}\x1b[0m`,
};
const line = (s = '') => { if (!JSON_ONLY) console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP（与 gh-audit 同款：5xx/超时重试，404/403/429 不重试）────────
async function req(url, { method = 'GET', manual = false } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method,
      redirect: manual ? 'manual' : 'follow',
      headers: { 'User-Agent': UA, Accept: '*/*' },
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

async function getText(url, { tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      await sleep(GAP_MS);
      const res = await req(url);
      if (res.ok) return await res.text();
      if (res.status === 404 || res.status === 403 || res.status === 429) return null;
    } catch { /* 网络抖动 → 重试 */ }
    await sleep(600 * (i + 1));
  }
  return null;
}

/** 拿 302 的 Location（releases/latest → /releases/tag/<tag>） */
async function getRedirect(url, { tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      await sleep(GAP_MS);
      const res = await req(url, { method: 'GET', manual: true });
      const loc = res.headers.get('location');
      if (loc) return { loc, status: res.status };
      if (res.status === 404) return { loc: null, status: 404 };
    } catch { /* 重试 */ }
    await sleep(600 * (i + 1));
  }
  return { loc: null, status: 0 };
}

// ── 缓存 ──────────────────────────────────────────────────────────
const cacheKey = (repo) => repo.replace('/', '__');
function readCache(repo) {
  const p = path.join(CACHE_DIR, `${cacheKey(repo)}.json`);
  if (!fs.existsSync(p)) return null;
  if (Date.now() - fs.statSync(p).mtimeMs > TTL_MS) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function writeCache(repo, val) {
  const p = path.join(CACHE_DIR, `${cacheKey(repo)}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try { fs.writeFileSync(p, JSON.stringify(val, null, 2)); } catch { /* 缓存写失败不影响主流程 */ }
}

// ── 版本归一化（用于「是不是同一个版本」的判断）───────────────────
/**
 * 把 tag 归一到「从第一个数字开始」的形式，用来跨写法比较：
 *   v9.15.0 → 9.15.0 · release-5.6.2 → 5.6.2 · MeshLab-2025.07 → 2025.07 · v2.0 → 2.0
 * ⚠️ 只在前缀/大小写上做归一，**不碰数字本身**（否则 2.1.0 与 2.1 会被当成同一个版本）。
 */
function normTag(s) {
  if (s === null || s === undefined) return '';
  let t = String(s).trim().toLowerCase();
  t = t.replace(/\s+/g, '');
  const i = t.search(/[0-9]/);
  if (i > 0) t = t.slice(i);
  return t;
}

/** 宽松比较：把结尾的 .0 段抹掉（2.0 与 2 视为同版），仅用于「写法差异」判定 */
function looseTag(s) {
  return normTag(s).replace(/(\.0)+$/, '');
}

// ── 取线上最新版本 ────────────────────────────────────────────────
async function fetchLatest(repo, { refresh }) {
  if (!refresh) {
    const hit = readCache(repo);
    if (hit) return { ...hit, cached: true };
  }

  let out = { tag: null, source: null, error: null };
  try {
    // ① releases/latest 的 302
    const { loc, status } = await getRedirect(`https://github.com/${repo}/releases/latest`);
    if (loc && /\/tag\//.test(loc)) {
      out.tag = decodeURIComponent(loc.split('/tag/').pop().split(/[?#]/)[0]).trim();
      out.source = 'latest-redirect';
    } else {
      // ② 兜底：最新版被标 pre-release 时 latest 会 302 到 /releases（无 tag）
      //    → 回退读 /releases 页，取第一个 tag（W1 连续多轮挂号的缺口，在这里补上）
      const html = await getText(`https://github.com/${repo}/releases`);
      if (html) {
        const m = html.match(/\/releases\/tag\/([^"'?#\\]+)/);
        if (m) {
          out.tag = decodeURIComponent(m[1]).replace(/\/+$/, '').trim();
          out.source = 'releases-page';
        } else {
          out.source = status === 404 ? 'no-releases' : 'no-tag';
        }
      } else {
        out.error = status === 404 ? null : 'fetch-failed';
        out.source = status === 404 ? 'no-releases' : 'fetch-failed';
      }
    }
  } catch (e) {
    out.error = String(e?.message || e);
    out.source = 'fetch-failed';
  }

  // 只有成功拿到 tag、或确定「没有 release」才落缓存；网络失败不缓存（下次重试）
  if (out.tag || out.source === 'no-releases' || out.source === 'no-tag') {
    writeCache(repo, { tag: out.tag, source: out.source, error: out.error, fetchedAt: new Date().toISOString() });
  }
  return { ...out, cached: false };
}

/** 取某 tag 的产物清单（仅在「待更新」时抓，控制在少量请求内） */
function parseAssets(html, repo, tag) {
  if (!html) return [];
  const out = [];
  for (const seg of html.split('/releases/download/').slice(1)) {
    const name = seg.split('"')[0];
    if (!name) continue;
    const size = seg.slice(0, 3000).match(/>\s*([\d.]+)\s*(KB|MB|GB)\s*</i);
    out.push({
      name: decodeURIComponent(name),
      size: size ? `${size[1]} ${size[2].toUpperCase()}` : null,
      url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
    });
  }
  const seen = new Set();
  return out.filter((a) => (seen.has(a.name) ? false : (seen.add(a.name), true)));
}

async function fetchAssets(repo, tag) {
  const html = await getText(`https://github.com/${repo}/releases/expanded_assets/${encodeURIComponent(tag)}`);
  return parseAssets(html, repo, tag);
}

// ── 并发池 ────────────────────────────────────────────────────────
async function pool(items, n, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

// ── 主流程 ────────────────────────────────────────────────────────
function classify(recordedTag, online) {
  if (online.error || online.source === 'fetch-failed') return 'error';
  if (!online.tag) {
    return online.source === 'no-releases' || online.source === 'no-tag' ? 'no-release' : 'error';
  }
  if (!recordedTag) return 'no-record';
  const a = normTag(recordedTag);
  const b = normTag(online.tag);
  if (a && a === b) return 'up-to-date';
  if (looseTag(recordedTag) && looseTag(recordedTag) === looseTag(online.tag)) return 'variant';
  return 'update';
}

const STATUS_CN = {
  update: '待更新',
  'up-to-date': '已最新',
  variant: '已最新（写法差异）',
  'no-record': '台账缺版本',
  'no-release': '线上无 release',
  error: '取数失败',
  'no-repo': '非 GitHub 源',
};

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const all = manifest.items || [];
  const ledger = fs.existsSync(LEDGER)
    ? JSON.parse(fs.readFileSync(LEDGER, 'utf8'))
    : { items: [] };
  const ledgerMap = new Map((ledger.items || []).map((x) => [x.id, x]));

  // 台账里的 latestTag 优先；若清单条目自带 version / latestTag，则以清单为准（未来兼容）
  const items = all
    .filter((x) => !ONLY.length || ONLY.includes(x.id))
    .map((m) => {
      const l = ledgerMap.get(m.id) || {};
      return {
        manifest: m,
        recordedTag: m.latestTag || m.version || l.latestTag || null,
        audits: l,
      };
    });

  const missing = ONLY.filter((id) => !all.some((x) => x.id === id));
  if (missing.length) line(c.y(`  ⚠️ --only 里这些 id 不在清单中：${missing.join(', ')}`));

  line('');
  line(c.b('══════ 版本巡检 gh-watch ══════'));
  line(`  清单 ${items.length} / ${all.length} 条${ONLY.length ? c.dim(`（指定 ${ONLY.join(', ')}）`) : ''}`);
  line(`  台账 ${path.relative(ROOT, LEDGER)}${ledger.generatedAt ? c.dim(` · 生成于 ${String(ledger.generatedAt).slice(0, 19)}`) : ''}`);
  line(`  缓存 .cache/gh-watch/${REFRESH ? c.dim('（--refresh 已忽略缓存）') : c.dim(`（TTL ${Math.round(TTL_MS / 3600_000)}h）`)}  并发 ${CONCURRENCY}`);
  line('');

  const records = await pool(items, CONCURRENCY, async (it) => {
    const repo = it.manifest.repo;
    if (!repo) {
      return {
        id: it.manifest.id, name: it.manifest.name, cn: it.manifest.cn || null,
        repo: null, recordedTag: it.recordedTag, onlineTag: null, status: 'no-repo',
        source: it.manifest.source || null, platforms: it.audits.platforms || [],
        arch: it.audits.arch || [], tier: it.audits.tier || null, action: it.audits.action || null,
        stars: it.audits.stars || 0, obligation: it.audits.obligation || null,
        redistributable: it.manifest.redistributable || null, newAssets: [], checkedAt: null,
      };
    }
    const online = await fetchLatest(repo, { refresh: REFRESH });
    const status = classify(it.recordedTag, online);
    let newAssets = [];
    if (status === 'update' && !NO_ASSETS) {
      newAssets = await fetchAssets(repo, online.tag);
    }
    line(`  ${({ update: c.y, error: c.r, 'no-release': c.m, 'no-record': c.cy }[status] || c.g)(STATUS_CN[status].padEnd(12))} ${String(it.manifest.id).padEnd(18)} ${String(it.recordedTag || '—').padEnd(16)} → ${(online.tag || '—').padEnd(16)} ${online.cached ? c.dim('(cache)') : ''}`);
    return {
      id: it.manifest.id, name: it.manifest.name, cn: it.manifest.cn || null,
      repo, recordedTag: it.recordedTag, onlineTag: online.tag || null, status,
      source: online.source, tagVariant: status === 'variant' ? `${it.recordedTag} ≈ ${online.tag}` : null,
      platforms: it.audits.platforms || [], arch: it.audits.arch || [],
      tier: it.audits.tier || null, action: it.audits.action || null,
      stars: it.audits.stars || 0, obligation: it.audits.obligation || null,
      redistributable: it.manifest.redistributable || null,
      newAssets: newAssets.map((a) => ({ name: a.name, size: a.size })),
      checkedAt: new Date().toISOString(),
      error: online.error || null,
    };
  });

  const by = (s) => records.filter((r) => r.status === s);
  const counts = {
    total: records.length,
    update: by('update').length,
    upToDate: by('up-to-date').length,
    variant: by('variant').length,
    noRecord: by('no-record').length,
    noRelease: by('no-release').length,
    error: by('error').length,
    skipped: by('no-repo').length,
  };

  const payload = {
    generatedAt: new Date().toISOString(),
    tool: 'gh-watch',
    manifest: path.relative(ROOT, MANIFEST),
    ledger: path.relative(ROOT, LEDGER),
    ledgerGeneratedAt: ledger.generatedAt || null,
    options: { only: ONLY, refresh: REFRESH, ttlMs: TTL_MS, concurrency: CONCURRENCY, assets: !NO_ASSETS },
    counts,
    updates: records.filter((r) => r.status === 'update').map((r) => r.id),
    items: records,
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));
  fs.writeFileSync(OUT_MD, renderMd(payload));

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify({ counts, updates: payload.updates }) + '\n');
  } else {
    line('');
    line(c.b('  ── 结论 ──'));
    line(`  ${c.y('🔄 待更新')}     ${counts.update}`);
    line(`  ${c.g('✅ 已最新')}     ${counts.upToDate + counts.variant}${counts.variant ? c.dim(`（含写法差异 ${counts.variant}）`) : ''}`);
    if (counts.noRecord) line(`  ${c.cy('○ 台账缺版本')}  ${counts.noRecord}`);
    if (counts.noRelease) line(`  ${c.m('◌ 线上无 release')} ${counts.noRelease}`);
    if (counts.error) line(`  ${c.r('✗ 取数失败')}    ${counts.error} ${c.dim('（GitHub 网页端抖动，重跑即可）')}`);
    if (counts.skipped) line(`  ${c.dim('— 非 GitHub 源')}  ${counts.skipped}`);
    line('');
    line(`  ${c.dim('→')} out/gh-watch.json`);
    line(`  ${c.dim('→')} out/gh-watch.md`);
    line('');
  }
  return payload;
}

// ── 报告 ──────────────────────────────────────────────────────────
function renderMd(p) {
  const L = [];
  const upd = p.items.filter((r) => r.status === 'update');
  const noRec = p.items.filter((r) => r.status === 'no-record');
  const noRel = p.items.filter((r) => r.status === 'no-release');
  const err = p.items.filter((r) => r.status === 'error');
  const ok = p.items.filter((r) => r.status === 'up-to-date' || r.status === 'variant');
  const skip = p.items.filter((r) => r.status === 'no-repo');

  L.push('# 开源软件 · 版本巡检报告（gh-watch）');
  L.push('');
  L.push(`> 生成时间：${p.generatedAt.replace('T', ' ').slice(0, 19)}`);
  L.push(`> 台账：\`${p.ledger}\`${p.ledgerGeneratedAt ? `（生成于 ${String(p.ledgerGeneratedAt).slice(0, 19)}）` : ''}`);
  L.push(`> 清单：\`${p.manifest}\` · 共 ${p.counts.total} 条`);
  L.push('> 取证方式：releases/latest 的 302 重定向 + /releases 页兜底（**不消耗 GitHub API 配额**）');
  L.push('');
  L.push('| 状态 | 条数 |');
  L.push('|---|---|');
  L.push(`| 🔄 待更新 | **${p.counts.update}** |`);
  L.push(`| ✅ 已最新 | ${p.counts.upToDate + p.counts.variant}${p.counts.variant ? `（含写法差异 ${p.counts.variant}）` : ''} |`);
  if (p.counts.noRecord) L.push(`| ○ 台账缺版本 | ${p.counts.noRecord} |`);
  if (p.counts.noRelease) L.push(`| ◌ 线上无 release | ${p.counts.noRelease} |`);
  if (p.counts.error) L.push(`| ✗ 取数失败 | ${p.counts.error} |`);
  if (p.counts.skipped) L.push(`| — 非 GitHub 源（跳过） | ${p.counts.skipped} |`);
  L.push('');

  L.push('## 一、待更新清单（本轮要处理的）');
  L.push('');
  if (!upd.length) {
    L.push('> ✅ 没有待更新条目 —— 台账版本与线上一致。');
    L.push('');
  } else {
    L.push('| id | 项目 | 台账版本 | 线上版本 | 平台 | 最新产物（新版本） | 分发义务 |');
    L.push('|---|---|---|---|---|---|---|');
    for (const r of upd) {
      const assets = (r.newAssets || [])
        .map((a) => `${a.name}${a.size ? ` (${a.size})` : ''}`)
        .slice(0, 4)
        .join('<br>') || '—';
      const more = (r.newAssets || []).length > 4 ? `<br><sub>…共 ${r.newAssets.length} 个</sub>` : '';
      L.push(`| \`${r.id}\` | ${r.name} | ${r.recordedTag || '—'} | **${r.onlineTag}** | ${(r.platforms || []).join('/') || '—'} | ${assets}${more} | ${r.obligation || '—'} |`);
    }
    L.push('');
    L.push('**建议动作**：① `npm run fetch:free` 拉新版本 → ② 核对官方 sha256 → ③ 更新网盘目录（保留上一版）→');
    L.push('④ 补一篇《更新合集》或改文章「版本更新记录」→ ⑤ 重跑 `npm run gh:audit` 把台账刷到最新。');
    L.push('');
  }

  if (noRec.length) {
    L.push('## 二、台账缺版本（需补录 / 首次纳入跟踪）');
    L.push('');
    L.push('| id | 项目 | 线上版本 | 备注 |');
    L.push('|---|---|---|---|');
    for (const r of noRec) L.push(`| \`${r.id}\` | ${r.name} | ${r.onlineTag} | 台账无 latestTag，重跑 \`npm run gh:audit\` 即可补上 |`);
    L.push('');
  }

  if (err.length) {
    L.push('## 三、取数失败（GitHub 网页端抖动，重跑即可）');
    L.push('');
    L.push('| id | 项目 | 台账版本 | 尝试结果 |');
    L.push('|---|---|---|---|');
    for (const r of err) L.push(`| \`${r.id}\` | ${r.name} | ${r.recordedTag || '—'} | ${r.error || r.source || '未知'} |`);
    L.push('');
  }

  if (noRel.length) {
    L.push('## 四、线上无 release（无稳定发版 / 页面取不到）');
    L.push('');
    L.push('| id | 项目 | 台账版本 | 说明 |');
    L.push('|---|---|---|---|');
    for (const r of noRel) L.push(`| \`${r.id}\` | ${r.name} | ${r.recordedTag || '—'} | latest 与 /releases 页均未取到 tag |`);
    L.push('');
  }

  L.push('## 五、已最新');
  L.push('');
  L.push('| id | 项目 | 版本 | 状态 |');
  L.push('|---|---|---|---|');
  for (const r of ok) L.push(`| \`${r.id}\` | ${r.name} | ${r.onlineTag} | ${r.tagVariant ? `⚠️ 写法差异 ${r.tagVariant}` : '✅'} |`);
  L.push('');

  if (skip.length) {
    L.push('## 六、非 GitHub 源（不参与版本巡检）');
    L.push('');
    L.push('| id | 项目 | 登记协议 | 再分发 | 说明 |');
    L.push('|---|---|---|---|---|');
    for (const r of skip) {
      const re = r.redistributable || 'yes';
      L.push(`| \`${r.id}\` | ${r.name} | ${r.tier || 'X'} | ${re} | 无 repo 字段，版本与条款须人工跟（见 freeware 条款核查） |`);
    }
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push(`元信息：并发 ${p.options.concurrency} · 缓存 TTL ${Math.round(p.options.ttlMs / 3600_000)}h${p.options.refresh ? ' · 本次 --refresh' : ''}`);
  L.push('');
  return L.join('\n');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(c.r('\n巡检失败：'), e);
    process.exit(1);
  });
