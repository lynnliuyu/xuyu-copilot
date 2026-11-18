#!/usr/bin/env node
/**
 * 自动抓「官方截图」当封面：对 manifest 里的开源条目，从它的**官方仓库 README** 里找截图下载。
 *
 * 为什么走 raw README 而不是仓库页面：GitHub 仓库页的 README 是异步加载的，
 * 直接 curl 页面上没有图；而 `raw.githubusercontent.com` 直连不通、**必须经 gh-proxy** 转发。
 *
 * 产出：assets/_shared/cover-inbox/<条目名>/official-<n>.<ext>
 *      （之后跑 npm run cover:inbox 接进站点）
 *
 * 用法：npm run fetch:covers [-- --only maccy,stats] [--force] [--dry]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INBOX = path.join(ROOT, 'assets', '_shared', 'cover-inbox');
const MANIFEST = path.join(ROOT, 'assets', 'free-software', 'manifest.json');
const TMP = path.join(ROOT, 'out', 'covers-fetch');
const PROXY = 'https://gh-proxy.com/';
const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY = (val('--only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const FORCE = argv.includes('--force');
const DRY = argv.includes('--dry');
const CONC = Number(val('--conc', '4'));

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(INBOX, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

/* 额外目标：不在 manifest 里、由用户指定官网的条目（键 = 网盘目录名） */
const TARGETS_FILE = path.join(ROOT, 'assets', '_shared', 'cover-targets.json');
const EXTRA = fs.existsSync(TARGETS_FILE)
  ? Object.entries(JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8')))
      .filter(([k]) => !k.startsWith('_'))
      .map(([name, url]) => ({ id: `t/${name}`, name, homepage: url, repo: null }))
  : [];
const ONLY_TARGETS = argv.includes('--targets');
/** ⚠️ id 里可能带 `/`（如 t/Bandizip）→ 直接拼进文件名会变成不存在的子目录，
    异常又被 catch 吞掉 → 表现为"一张图都抓不到"。一律 slug 化。 */
const slug = (s) => String(s).replace(/[^\w.-]+/g, '_');
const TMPFILE = (item, suffix) => path.join(TMP, `${slug(item.id)}${suffix}`);

const skip = /(shields\.io|badge|badgen|travis|circleci|codecov|githubassets|avatars\.githubusercontent|\.svg$|\/actions\/workflows)/i;
const want = /\.(png|jpe?g|gif|webp)$/i;
/** URL 可能带 ?v=2 这类查询串 —— 判扩展名要看 **去查询串** 的部分（这是个真踩过的坑） */
const extOf = (u) => ((u.split('?')[0].split('#')[0].match(want) || [''])[0]).toLowerCase().replace('jpeg', 'jpg');
/** raw.githubusercontent.com 直连不通 → 一律走 gh-proxy */
const proxied = (u) => (/^https:\/\/raw\.githubusercontent\.com\//.test(u) ? PROXY + u : u);

/* 官网就是 GitHub 仓库的条目，README 里没有像样截图 → 直接用它的真官网 */
const SITE_OVERRIDE = {
  maccy: 'https://maccy.app',
  'alt-tab': 'https://alt-tab.app',
  fsnotes: 'https://fsnotes.com',
  easydict: 'https://www.easydict.com',
  mediainfo: 'https://mediaarea.net/MediaInfo',
  'mediainfo-gui': 'https://mediaarea.net/MediaInfo',
  xnviewmp: 'https://www.xnview.com/en/xnviewmp/',
};

// ⚠️ 不能只筛有 repo 的 —— XnViewMP/MediaInfo 这类没有 GitHub 仓库，只靠官网兜底
let items = ONLY_TARGETS ? [...EXTRA] : [...manifest.items.filter((x) => x.repo || SITE_OVERRIDE[x.id] || x.homepage), ...EXTRA];
if (ONLY.length) items = items.filter((x) => ONLY.includes(x.id));

const http = async (url, out) => {
  const args = ['-sL', '--max-time', '40', '-A', 'Mozilla/5.0'];
  if (out) args.push('-o', out);
  args.push('-w', '%{http_code}', url);
  const { stdout } = await pexec('curl', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 << 20 });
  return stdout.trim();
};

/** 读 README 原文（多次尝试常见分支/文件名） */
async function readme(repo) {
  for (const branch of ['HEAD', 'main', 'master']) {
    for (const name of ['README.md', 'readme.md', 'Readme.md', 'README.markdown']) {
      const u = `${PROXY}https://raw.githubusercontent.com/${repo}/${branch}/${name}`;
      try {
        const { stdout } = await pexec('curl', ['-sL', '--max-time', '25', '-A', 'Mozilla/5.0', u], { encoding: 'utf8', timeout: 40_000, maxBuffer: 8 << 20 });
        if (stdout && stdout.length > 200 && !/^404/.test(stdout.slice(0, 4))) return { text: stdout, base: `https://raw.githubusercontent.com/${repo}/${branch}/` };
      } catch { /* 继续试 */ }
    }
  }
  return null;
}

/** 从 markdown 里挑图片 URL（绝对 + 相对） */
function pickImages(md, base) {
  const urls = [];
  for (const m of md.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) urls.push(m[1]);
  for (const m of md.matchAll(/<img[^>]+src="([^"]+)"/g)) urls.push(m[1]);
  const abs = urls
    .filter((u) => !skip.test(u) && extOf(u))
    .map((u) => {
      if (!/^https?:/.test(u)) return base + u.replace(/^\.?\//, '');
      return proxied(u.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/raw\//, 'https://raw.githubusercontent.com/$1/'));
    });
  return [...new Set(abs)];
}

/** 兜底：从官方站点 HTML 里挑（优先 og:image） */
function pickFromSite(html, base) {
  const og = [...html.matchAll(/<meta[^>]+(?:property|name)="(?:og:image|twitter:image)"[^>]+content="([^"]+)"/g)].map((m) => m[1]);
  const imgs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  const all = [...og, ...imgs]
    .filter((u) => !skip.test(u) && extOf(u))
    .map((u) => proxied(/^https?:/.test(u) ? u : new URL(u, base).href));
  return [...new Set(all)];
}

/** 合格判据：够大 + 长宽比不像"横幅条/长图" */
const okSize = (w, h) => w >= 600 && h >= 300 && w / h >= 0.7 && w / h <= 3.2;

async function one(item) {
  const hit = await readme(item.repo);
  let cands = hit ? pickImages(hit.text, hit.base) : [];
  const site = SITE_OVERRIDE[item.id] || item.homepage;
  if (site) {
    try {
      const f = TMPFILE(item, '-site.html');
      const code = await http(site, f);
      if (code === '200' && fs.existsSync(f)) {
        cands = cands.concat(pickFromSite(fs.readFileSync(f, 'utf8'), site));
      } else {
        console.log(`     · ${item.name}: 官网取不到（HTTP ${code ?? '?'}）`);
      }
    } catch (e) {
      console.log(`     · ${item.name}: 官网抓取出错 ${String(e.message).slice(0, 60)}`);
    }
  }
  if (!cands.length) return { item, ok: false, why: 'README/站点都没取到图' };
  for (const url of cands.slice(0, 10)) {
    const ext = extOf(url) || '.png';
    const f = TMPFILE(item, `-${Math.random().toString(36).slice(2, 7)}${ext}`);
    try {
      const code = await http(url, f);
      if (code !== '200' || !fs.existsSync(f) || fs.statSync(f).size < 12_000) continue;
      const { stdout } = await pexec('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', f], { encoding: 'utf8' });
      const w = Number((stdout.match(/pixelWidth:\s*(\d+)/) || [])[1] || 0);
      const h = Number((stdout.match(/pixelHeight:\s*(\d+)/) || [])[1] || 0);
      if (!okSize(w, h)) continue;
      return { item, ok: true, file: f, url, w, h, bytes: fs.statSync(f).size };
    } catch { /* 试下一张 */ }
  }
  return { item, ok: false, why: `${cands.length} 张候选都不合格` };
}

let i = 0;
const results = [];
async function worker() {
  while (i < items.length) {
    const it = items[i++];
    const dir = path.join(INBOX, it.name);
    if (!FORCE && fs.existsSync(dir) && fs.readdirSync(dir).some((f) => !f.startsWith('.'))) {
      results.push({ item: it, ok: true, skipped: true });
      console.log(`  ⏭  ${it.name}　已有图，跳过`);
      continue;
    }
    const r = await one(it);
    results.push(r);
    if (r.ok && !r.skipped) {
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `official-1${path.extname(r.file)}`);
      if (!DRY) fs.copyFileSync(r.file, dest);
      console.log(`  ✅ ${it.name.padEnd(18)} ${r.w}×${r.h}  ${(r.bytes / 1024).toFixed(0)} KB  ← ${r.url.slice(0, 70)}`);
    } else if (!r.skipped) {
      console.log(`  ✗  ${it.name.padEnd(18)} ${r.why}`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

const ok = results.filter((r) => r.ok).length;
console.log(`\n成功 ${ok} / ${results.length}${DRY ? '　【dry-run】' : ''}`);
if (ok && !DRY) console.log('下一步：npm run cover:inbox && npm run site:netdisk');
