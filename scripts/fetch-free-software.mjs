#!/usr/bin/env node
/**
 * 下载「免费 / 开源 macOS 软件」的**官方安装包**。
 *
 * ── 为什么不从 repackmac 的下载源拿
 * 那个站给的是重打包版本，下载源是 FileNest / MediaFire 这类国外网盘（可能过验证码、
 * 也可能被改动过）。而这些软件**官方就在发版** —— 取官方包更干净、版本更新、
 * 还能核对官方校验值。清单见 `assets/free-software/manifest.json`。
 *
 * ── 单平台 vs 多平台
 *   默认：每个项目按 `manifest.json` 的 `asset` 正则取**一个**包（macOS 档）。
 *   多平台：若 `assets/free-software/multiplatform.json` 里配了该项目，则按那张表
 *          逐个平台取包（**只取主推形态，且排除调试符号** —— dSYM/PDB/dbsym 能占掉
 *          一半体积，对读者零价值）。两种模式共用一次 GitHub API 调用。
 *
 * ── 用法
 *   npm run fetch:free                  # 下载清单里所有可解析的
 *   npm run fetch:free -- --only maccy,alt-tab
 *   npm run fetch:free -- --list        # 只列出清单，不下载
 *
 * 产物：`assets/free-software/downloads/<文件名>`（已 gitignore）+ `out/free-software.json`（含 sha256）
 *
 * ⚠️ 国内的网络环境：GitHub Release 直连很慢甚至超时，默认走 gh-proxy.com 镜像。
 *    镜像只做中转，所以下载后**必须核对官方 sha256**（GitHub 的 asset 有 `digest` 字段）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'assets', 'free-software', 'manifest.json');
const MULTI_FILE = path.join(ROOT, 'assets', 'free-software', 'multiplatform.json');
const DL_DIR = path.join(ROOT, 'assets', 'free-software', 'downloads');
const OUT = path.join(ROOT, 'out', 'free-software.json');
const MIRROR = process.env.GH_MIRROR || 'https://gh-proxy.com/';

// 超时（毫秒）：API 短、下载长。没有超时会被一个挂起的官方站拖死整批。
const API_TIMEOUT_MS = Number(process.env.FETCH_API_TIMEOUT_MS || 30_000);
const DL_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20 * 60_000);

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]).split(',').map((s) => s.trim()) : [];
})();

const line = (s = '') => console.log(s);
const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const items = manifest.items.filter((x) => !ONLY.length || ONLY.includes(x.id));

/** 多平台精选规则：id → [{ platform, arch, match }] */
const MULTI = fs.existsSync(MULTI_FILE)
  ? JSON.parse(fs.readFileSync(MULTI_FILE, 'utf8')).items || {}
  : {};

line('');
line(b('══════ 下载免费/开源软件（官方包）══════'));
line(`  清单 ${items.length} 个${ONLY.length ? `（指定 ${ONLY.join(', ')}）` : ''}`);
line('');

if (has('--list')) {
  for (const it of items) {
    const ok = it.repo || it.url;
    const multi = MULTI[it.id];
    line(`  ${ok ? green('·') : red('×')} ${String(it.id).padEnd(18)} ${it.name.padEnd(18)} ${it.cn}`);
    if (multi) line(dim(`      多平台 ${multi.map((m) => m.platform + (m.arch ? `(${m.arch})` : '')).join(' ')}`));
    if (!ok) line(dim(`      ${it.note ?? '来源待核实'}`));
  }
  line('');
  process.exit(0);
}

fs.mkdirSync(DL_DIR, { recursive: true });

/**
 * 取 GitHub Release 里匹配的资产（顺带拿到官方 digest）。
 * 多平台条目一次返回多个文件；单平台条目返回一个。
 */
async function resolveGithub(it) {
  const r = await fetch(`https://api.github.com/repos/${it.repo}/releases/latest`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`GitHub API HTTP ${r.status}`);
  const d = await r.json();

  const multi = MULTI[it.id];
  if (multi) {
    const files = [];
    const missing = [];
    for (const spec of multi) {
      const re = new RegExp(spec.match, 'i');
      const a = (d.assets || []).find((x) => re.test(x.name));
      // ⚠️ 某个平台缺包时不整条失败 —— 记下来继续下别的，否则一个平台缺失会
      //    把整个项目拖成"失败"，而那可能只是上游这版没发该平台的包。
      if (!a) {
        missing.push(`${spec.platform}${spec.arch ? `(${spec.arch})` : ''}`);
        continue;
      }
      files.push({
        platform: spec.platform,
        arch: spec.arch || null,
        url: a.browser_download_url,
        file: a.name,
        bytes: a.size,
        digest: a.digest || null,
      });
    }
    if (!files.length) throw new Error(`多平台：全部未匹配（tag ${d.tag_name}）`);
    return { files, missing, version: d.tag_name };
  }

  const re = it.asset ? new RegExp(it.asset, 'i') : /\.(dmg|zip)$/i;
  const a = (d.assets || []).find((x) => re.test(x.name));
  if (!a) throw new Error(`没有匹配 ${it.asset ?? '.dmg/.zip'} 的资产（tag ${d.tag_name}）`);
  return { url: a.browser_download_url, file: a.name, bytes: a.size, version: d.tag_name, digest: a.digest || null };
}

/** 下载（GitHub 的走镜像；官方站直连）。已存在且大小一致的直接复用，不重复下。 */
async function download(url, dest, viaMirror, expectBytes = 0) {
  if (fs.existsSync(dest)) {
    const cur = fs.statSync(dest).size;
    // GitHub 的 asset 有 sizes 可对；官方站拿不到就按 >1MB 视为已完成
    if ((expectBytes && cur === expectBytes) || (!expectBytes && cur > 1024 * 1024)) {
      return { size: cur, reused: true };
    }
  }
  const target = viaMirror ? MIRROR + url : url;
  // ⚠️ 必须带超时：官方站遇到 404/挂起时不设超时会**静默卡住整批**
  const r = await fetch(target, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    redirect: 'follow',
    signal: AbortSignal.timeout(DL_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return { size: buf.length, reused: false };
}

/**

 * 下载一个文件并算出核对结果（单平台/多平台共用）
 */
async function fetchOne(f, viaMirror, label) {
  const dest = path.join(DL_DIR, f.file);
  const dl = await download(f.url, dest, viaMirror, f.bytes);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  // ⚠️ 走镜像必须核对官方 digest —— 第三方代理有被篡改的可能
  const verified = f.digest ? String(f.digest).replace(/^sha256:/, '') === sha : null;
  const tag =
    verified === true ? green('校验一致')
      : verified === false ? red('⚠️ 校验不一致')
        : dim('无官方摘要');
  return { dest, dl, sha, verified, tag };
}

const results = [];
let ok = 0;
let fail = 0;

for (const it of items) {
  const label = `${String(it.id).padEnd(18)} ${String(it.name).padEnd(18)}`;
  if (!it.repo && !it.url) {
    line(`  ${yellow('跳过')} ${label} ${dim(it.note ?? '来源待核实')}`);
    results.push({ ...it, status: 'pending-source' });
    continue;
  }
  try {
    const meta = it.repo
      ? await resolveGithub(it)
      : { url: it.url, file: path.basename(new URL(it.url).pathname), bytes: 0, version: '', digest: null };

    /* ── 多平台：一个项目多个包 ───────────────────────────────── */
    if (meta.files) {
      const got = [];
      for (const f of meta.files) {
        const r = await fetchOne(f, true, label);
        line(
          `  ${green('✅')} ${label} ${dim(String(f.platform).padEnd(7))} ` +
          `${(r.dl.size / 1048576).toFixed(1).padStart(7)} MB  ${String(f.arch || '').padEnd(10)} ` +
          `${r.tag}${r.dl.reused ? dim(' (缓存)') : ''}`,
        );
        got.push({
          platform: f.platform,
          arch: f.arch,
          file: f.file,
          local: r.dest,
          bytes: r.dl.size,
          sha256: r.sha,
          official_digest: f.digest,
          verified: r.verified,
          download_url: f.url,
        });
      }
      if (meta.missing?.length) {
        line(`  ${yellow('⚠️')} ${label} 上游本版没有这些平台的包：${meta.missing.join('、')}`);
      }
      const p0 = got[0];
      // 顶层字段保留，老消费方（push:free 的单平台分支）继续可用
      results.push({
        ...it,
        status: 'downloaded',
        version: meta.version,
        files: got,
        file: p0.file,
        local: p0.local,
        bytes: p0.bytes,
        sha256: p0.sha256,
        official_digest: p0.official_digest,
        verified: p0.verified,
        download_url: p0.download_url,
        downloaded_at: new Date().toISOString(),
      });
      ok++;
      continue;
    }

    /* ── 单平台 ──────────────────────────────────────────────── */
    const r = await fetchOne(meta, !!it.repo, label);
    const size = r.dl.size;
    line(
      `  ${green('✅')} ${label} ${(size / 1048576).toFixed(1).padStart(7)} MB  ` +
      `${String(meta.version).padEnd(10)} ${r.tag}${r.dl.reused ? dim(' (缓存)') : ''}`,
    );
    results.push({
      ...it,
      status: 'downloaded',
      version: meta.version,
      file: meta.file,
      local: r.dest,
      bytes: size,
      sha256: r.sha,
      official_digest: meta.digest,
      verified: r.verified,
      download_url: meta.url,
      downloaded_at: new Date().toISOString(),
    });
    ok++;
  } catch (e) {
    line(`  ${red('✗')} ${label} ${red(String(e?.message ?? e).slice(0, 80))}`);
    results.push({ ...it, status: 'failed', error: String(e?.message ?? e) });
    fail++;
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), items: results }, null, 2));

line('');
line(`${b('汇总')}：成功 ${green(String(ok))}　失败 ${red(String(fail))}　待核实来源 ${yellow(String(results.filter((r) => r.status === 'pending-source').length))}`);
line(dim(`  安装包：${path.relative(ROOT, DL_DIR)}/　清单：${path.relative(ROOT, OUT)}`));
line('');
