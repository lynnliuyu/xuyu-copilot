#!/usr/bin/env node
/**
 * ArtCraft 套件 · 中文使用手册生成器
 *
 * 做什么
 * ------
 * 把 scripts/artcraft-manual-data.mjs 里的中文手册数据渲染成 HTML，再用
 * **无头 Chrome 打印成 PDF**（矢量文字、可搜索、可复制，不是截图）。
 * 产物：
 *    out/artcraft-manual/<id>/<AppName> 使用手册.pdf     —— 单应用手册（13 份）
 *    out/artcraft-manual/ArtCraft 全家桶 使用手册.pdf    —— 合集（含目录）
 *
 * 为什么用 Chrome 而不是 PDF 库
 * ----------------------------
 *  项目里已有无头 Chrome（出商品图就靠它），打印 PDF 零新增依赖，
 *  且中文字体直接走系统 PingFang SC，不用打包字体文件。
 *
 * 用法：
 *   node scripts/artcraft-manual.mjs              # 出全部 PDF
 *   node scripts/artcraft-manual.mjs figcraft     # 只出指定的
 *   node scripts/artcraft-manual.mjs --html-only  # 只出 HTML（调试排版用）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { APPS, COMMON } from './artcraft-manual-data.mjs';

// ⚠️ 不要写死绝对路径：换机 / 换用户名 / Windows 都会直接崩。
//    ROOT 由脚本自身位置推导（scripts/ 的上一级），Chrome 允许用 CHROME_PATH 覆盖。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out', 'artcraft-manual');
const CHROME =
  process.env.CHROME_PATH ||
  (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

const argv = process.argv.slice(2);
const HTML_ONLY = argv.includes('--html-only');
const only = argv.filter((a) => !a.startsWith('--'));
const targets = only.length ? APPS.filter((a) => only.includes(a.id)) : APPS;

/* ───────────────────────── HTML 拼接 ───────────────────────── */

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 行内标记：**粗体** 与 `代码` → HTML */
const inl = (s) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

const CSS = `
:root{
  --ink:#1b1b1f; --ink2:#4a4a55; --ink3:#7c7c8a;
  --line:#e3e3ea; --bg:#ffffff; --soft:#f6f7fb;
  --brand:#3a4bd6; --brand-soft:#eef0ff;
}
@page{ size:A4; margin:17mm 15mm 15mm; }
*{ box-sizing:border-box; }
html,body{ margin:0; padding:0; background:var(--bg); }
body{
  font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;
  color:var(--ink); font-size:10.4pt; line-height:1.66;
  -webkit-font-smoothing:antialiased;
}
code{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:9.4pt; background:var(--soft); border:1px solid var(--line);
  border-radius:3px; padding:0 .3em; word-break:break-all;
}

/* —— 封面块 —— */
.cover{ border-left:5px solid var(--brand); padding:2mm 0 3mm 5mm; margin-bottom:7mm; }
.cover .kicker{ font-size:9pt; color:var(--brand); letter-spacing:.16em; margin-bottom:1.5mm; }
.cover h1{ font-size:23pt; line-height:1.22; margin:0 0 2mm; letter-spacing:-.01em; }
.cover .sub{ font-size:11.5pt; color:var(--ink2); margin-bottom:3mm; }
.cover .meta{ font-size:9.2pt; color:var(--ink3); line-height:1.75; }
.cover .meta b{ color:var(--ink2); font-weight:600; }

/* —— 章节 —— */
h2{
  font-size:13pt; margin:7mm 0 2.5mm; padding-bottom:1.4mm;
  border-bottom:1.4px solid var(--line); letter-spacing:-.005em;
}
h2:first-of-type{ margin-top:0; }
h2 .n{ color:var(--brand); margin-right:1.5mm; font-weight:700; }
h3{ font-size:10.6pt; margin:4mm 0 1.5mm; color:var(--ink); }
p{ margin:0 0 2.4mm; }
ul,ol{ margin:0 0 2.8mm; padding-left:5.2mm; }
li{ margin-bottom:1.5mm; }
li::marker{ color:var(--brand); }

/* —— 表格 —— */
table{ width:100%; border-collapse:collapse; margin:0 0 3mm; font-size:9.7pt; }
th,td{
  text-align:left; vertical-align:top; padding:1.7mm 2.2mm;
  border-bottom:1px solid var(--line);
}
th{ background:var(--soft); font-weight:600; color:var(--ink2); font-size:9.3pt; }
td:first-child{ white-space:nowrap; font-weight:600; width:24%; }
tr{ page-break-inside:avoid; }

/* —— FAQ —— */
.faq{ margin:0; }
.faq dt{ font-weight:600; margin-top:2.8mm; }
.faq dt::before{ content:"Q "; color:var(--brand); font-weight:700; }
.faq dd{ margin:.6mm 0 0 5.4mm; color:var(--ink2); }
.faq dd::before{ content:"A "; color:var(--ink3); font-weight:700; margin-left:-5.4mm; }
.faq dt,.faq dd{ page-break-inside:avoid; }

/* —— 提示条 —— */
.note{
  background:var(--brand-soft); border-left:3px solid var(--brand);
  padding:2.2mm 3mm; margin:0 0 3mm; font-size:9.8pt; page-break-inside:avoid;
}
.note.warn{ background:#fff8ec; border-left-color:#d98a00; }
.note b{ font-weight:600; }

/* —— 合集目录 —— */
.toc{ font-size:10pt; }
.toc div{ display:flex; padding:1.4mm 0; border-bottom:1px dotted var(--line); }
.toc .t{ width:9mm; color:var(--ink3); }
.toc .n{ flex:1; font-weight:600; }
.toc .d{ color:var(--ink2); }
.chapter{ page-break-before:always; }
.chapter:first-of-type{ page-break-before:auto; }

footer{
  margin-top:8mm; padding-top:2.5mm; border-top:1px solid var(--line);
  font-size:8.6pt; color:var(--ink3);
}
`;

function cover(a, { combined = false } = {}) {
  const lines = [];
  lines.push(`<div class="cover">`);
  lines.push(`<div class="kicker">ARTCRAFT 开源创作套件</div>`);
  lines.push(`<h1>${esc(a.name)} 使用手册</h1>`);
  lines.push(
    `<div class="sub">${esc(a.cn)}　·　v${esc(a.ver)}` +
      (a.replace ? `　·　对标 ${esc(a.replace)}` : '') +
      (combined ? '　·　合集版' : '') +
      `</div>`
  );
  lines.push(`<div class="meta">`);
  lines.push(`官网 <b>${esc(a.site)}</b><br>`);
  lines.push(`源码 <b>${esc(a.repo)}</b>`);
  lines.push(`</div></div>`);
  return lines.join('\n');
}

/** 安装段：按各应用实际安装包名生成，artcraft 的 Windows 包名不同 */
function installSection(a) {
  const f = a.files;
  const win = [];
  if (f.exe) win.push(`双击 <code>${esc(f.exe)}</code> 按提示安装（构建版安装程序）。`);
  if (f.msi) win.push(`或双击 <code>${esc(f.msi)}</code> 走 Windows Installer 安装。`);
  if (f.port) win.push(`想免安装：解压 <code>${esc(f.port)}</code>，直接运行里面的 exe。`);
  const mac = [`双击 <code>${esc(f.mac)}</code>，把图标拖进「应用程序」。`];

  return `
<h2><span class="n">二</span>安装</h2>
<h3>Windows 10 / 11（建议 64 位）</h3>
<ol>${win.map((x) => `<li>${x}</li>`).join('')}</ol>
<h3>macOS</h3>
<ol>${mac.map((x) => `<li>${x}</li>`).join('')}</ol>
<div class="note warn"><b>首次运行会被系统拦一下，属正常现象</b>（未购买商业代码签名证书）：Windows 点「更多信息 → 仍要运行」；macOS 到「系统设置 → 隐私与安全性」点「仍要打开」。</div>
<h3>校验文件完整性（可选）</h3>
<p>${inl(COMMON.verify)}</p>`;
}

function langSection(a) {
  const l = a.lang;
  if (!l.supported) {
    return `
<h2><span class="n">三</span>界面语言</h2>
<p>${inl(l.how)}${inl(l.note)}</p>`;
  }
  return `
<h2><span class="n">三</span>界面语言（含简体中文）</h2>
<p>${inl(l.how)}</p>
<p><b>可选语言：</b>${inl(l.list)}</p>
${l.note ? `<div class="note">${inl(l.note)}</div>` : ''}`;
}

function manualBody(a, { withCover = true } = {}) {
  const out = [];
  if (withCover) out.push(cover(a));
  out.push(`<h2><span class="n">一</span>这是什么</h2><p>${inl(a.what)}</p>`);
  out.push(installSection(a));
  out.push(langSection(a));
  out.push(
    `<h2><span class="n">四</span>快速上手</h2><ol>${a.start.map((s) => `<li>${inl(s)}</li>`).join('')}</ol>`
  );
  out.push(`
<h2><span class="n">五</span>常用功能速查</h2>
<table>
<tr><th>功能</th><th>说明</th></tr>
${a.features.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${inl(v)}</td></tr>`).join('')}
</table>`);
  out.push(`
<h2><span class="n">六</span>支持的文件格式</h2>
<table>
${a.formats.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${inl(v)}</td></tr>`).join('')}
</table>`);
  out.push(`
<h2><span class="n">七</span>常见问题</h2>
<dl class="faq">
${a.faq.map(([q, ans]) => `<dt>${inl(q)}</dt><dd>${inl(ans)}</dd>`).join('')}
</dl>`);
  if (a.limits?.length) {
    out.push(`
<h2><span class="n">八</span>已知限制（官方明示，先看这段再决定）</h2>
<p>以下均为该项目官方 README 自行披露的限制，整理在此以免安装后才发现：</p>
<ul>${a.limits.map((x) => `<li>${inl(x)}</li>`).join('')}</ul>`);
  }
  out.push(`
<h2><span class="n">${a.limits?.length ? '九' : '八'}</span>许可证与来源</h2>
<ul>
<li><b>许可证：</b>${inl(COMMON.license)}</li>
<li><b>来源：</b>${inl(COMMON.source)}</li>
<li><b>官网：</b>${esc(a.site)}　<b>源码：</b>${esc(a.repo)}</li>
</ul>
<footer>本手册由整理者依据该项目官方 README 编写，用于安装与上手说明；功能以实际软件版本为准。整理日期 2026-10-16。</footer>`);
  return out.join('\n');
}

function wrap(title, body, extraCss = '') {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${CSS}${extraCss}</style></head><body>
${body}
</body></html>`;
}

/* ───────────────────────── 出图 ───────────────────────── */

function printPdf(htmlPath, pdfPath) {
  fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
  execFileSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-pdf-header-footer',
      '--virtual-time-budget=10000',
      `--print-to-pdf=${pdfPath}`,
      pathToFileURL(htmlPath).href,
    ],
    { stdio: 'pipe', timeout: 120_000 }
  );
  const kb = (fs.statSync(pdfPath).size / 1024).toFixed(0);
  console.log(`  ✓ ${path.basename(pdfPath)}　${kb} KB`);
}

fs.mkdirSync(OUT, { recursive: true });
console.log(`══ 生成中文使用手册（${targets.length} 份） ══`);

for (const a of targets) {
  const html = wrap(`${a.name} 使用手册`, manualBody(a));
  const dir = path.join(OUT, a.id);
  fs.mkdirSync(dir, { recursive: true });
  const htmlPath = path.join(dir, `${a.name} 使用手册.html`);
  fs.writeFileSync(htmlPath, html, 'utf8');
  if (HTML_ONLY) {
    console.log(`  ✓ ${htmlPath}`);
    continue;
  }
  printPdf(htmlPath, path.join(dir, `${a.name} 使用手册.pdf`));
}

/* 合集：目录 + 每章前分页 */
if (!only.length) {
  const toc = APPS.map(
    (a, i) =>
      `<div><span class="t">${String(i + 1).padStart(2, '0')}</span>` +
      `<span class="n">${esc(a.name)}　<span class="d">${esc(a.cn)}</span></span>` +
      `<span class="d">v${esc(a.ver)}${a.replace ? `　对标 ${esc(a.replace)}` : ''}</span></div>`
  ).join('');

  const intro = `
<div class="cover">
  <div class="kicker">ARTCRAFT 开源创作套件</div>
  <h1>13 款应用 使用手册合集</h1>
  <div class="sub">修图 · 矢量 · 排版 · 动效 · 音频 · CAD · UI 设计 · 幻灯片 · 文档 · PDF · 照片冲图 · AI 创作</div>
  <div class="meta">
    官网 <b>https://getartcraft.com</b><br>
    许可证 <b>MIT OR Apache-2.0 双许可</b>　·　整理日期 <b>2026-10-16</b>
  </div>
</div>
<h2><span class="n">目</span>录</h2>
<div class="toc">${toc}</div>
<h2><span class="n">怎</span>么用这份合集</h2>
<ul>
<li>每个应用一章，章节之间独立，可以直接跳到你要装的那个。</li>
<li>只装了单个应用的话，对应目录里另有一份单独的手册，内容与本章一致。</li>
<li>安装包与手册都在同一目录：Windows 用 <code>.msi</code> 或 portable <code>.zip</code>，macOS 用 <code>.dmg</code>。</li>
<li>每章末尾都写明该应用的<b>已知限制</b>——那段是官方自己披露的，建议安装前先看。</li>
</ul>`;

  const chapters = APPS.map(
    (a) => `<div class="chapter">${cover(a)}${manualBody(a, { withCover: false })}</div>`
  ).join('\n');

  const html = wrap('ArtCraft 全家桶 使用手册合集', intro + chapters);
  const htmlPath = path.join(OUT, '_合集.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log('\n══ 合集 ══');
  if (HTML_ONLY) {
    console.log(`  ✓ ${htmlPath}`);
  } else {
    printPdf(htmlPath, path.join(OUT, 'ArtCraft 全家桶 使用手册.pdf'));
  }
}

console.log(`\n产物目录：${OUT}`);
if (!HTML_ONLY) {
  console.log('下一步：上传到网盘\n' +
    "  bdpan upload \"out/artcraft-manual/figcraft/FigCraft 使用手册.pdf\" '软件/ArtCraft 开源套件/figcraft/FigCraft 使用手册.pdf'\n" +
    "  bdpan upload \"out/artcraft-manual/ArtCraft 全家桶 使用手册.pdf\" '软件/ArtCraft 开源套件/ArtCraft 全家桶 使用手册.pdf'");
}
