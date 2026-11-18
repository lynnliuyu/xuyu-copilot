#!/usr/bin/env node
/**
 * ArtCraft 系列商品图重制 —— 官方 UI 截图 + 官方图标。
 *
 * 背景：原来 14 张图是「同一套紫渐变模板 + 同一个通用占位图标，只换文字」，
 *       在闲鱼列表里全一个样。本脚本改成每张都用该应用**官方素材**：
 *         · 官方 UI 截图（主角，各应用界面天生不同）
 *         · 官方应用图标（从官方 .dmg 提取，另见 scripts/fetch-artcraft-official.py）
 *         · 强调色取自该图标主色
 *
 * 用法：
 *   npx tsx scripts/render-artcraft-cards.mjs                 # 全部渲染到 out/artcraft-cards/
 *   npx tsx scripts/render-artcraft-cards.mjs figcraft        # 只渲染指定（可用 code 或 resource_id）
 *   npx tsx scripts/render-artcraft-cards.mjs --upload        # 渲染 → 上传图床 → 回填草稿与资源条目
 *
 * ⚠️ 文件名带 `-v2`：闲鱼是**服务端抓图**，URL 不变很可能命中它的图片缓存、
 *    不重新抓取（见 render-covers.mjs 的同款注释）。
 * ⚠️ 不加 --upload 时本脚本只写 out/，绝不碰草稿、绝不碰线上商品。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderArtcraftCard, SIZE } from '../assets/_shared/card-artcraft.mjs';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets', 'artcraft-official');
const OUT = path.join(ROOT, 'out', 'artcraft-cards');
const DRAFTS = path.join(ROOT, 'drafts', '.resources.json');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TAG = 'v2';

/** 单品：resource_id → 草稿 code / 名称 / 副题 */
const APPS = [
  { id: 'artcraft', code: 'BD-ARTCRAFT', en: 'ArtCraft', cn: 'AI 创作工作台（2D/3D 搭景 + AI 出图）' },
  { id: 'photocraft', code: 'BD-PHOTOCRAFT', en: 'PhotoCraft', cn: '开源照片编辑器' },
  { id: 'pdfcraft', code: 'BD-PDFCRAFT', en: 'PdfCraft', cn: '开源 PDF 阅读与编辑器' },
  { id: 'lightcraft', code: 'BD-LIGHTCRAFT', en: 'LightCraft', cn: '开源无损照片编辑器' },
  { id: 'wordcraft', code: 'BD-WORDCRAFT', en: 'WordCraft', cn: '开源文字处理' },
  { id: 'vectorcraft', code: 'BD-VECTORCRAFT', en: 'VectorCraft', cn: '开源矢量绘图工具' },
  { id: 'effectcraft', code: 'BD-EFFECTCRAFT', en: 'EffectCraft', cn: '开源动效与合成工具' },
  { id: 'cadcraft', code: 'BD-CADCRAFT', en: 'CADCraft', cn: '开源 CAD 制图工具' },
  { id: 'designcraft', code: 'BD-DESIGNCRAFT', en: 'DesignCraft', cn: '开排版面设计工具' },
  { id: 'deckcraft', code: 'BD-DECKCRAFT', en: 'DeckCraft', cn: '开源演示文稿' },
  { id: 'soundcraft', code: 'BD-SOUNDCRAFT', en: 'SoundCraft', cn: '开源音频工作站' },
  { id: 'figcraft', code: 'BD-FIGCRAFT', en: 'FigCraft', cn: '开源界面设计与原型' },
  { id: 'craft-launcher', code: 'BD-CRAFT-LAUNCHER', en: 'Craft Launcher', cn: 'Craft 全家桶启动器' },
];

/** 套件：13 个图标拼成一面墙 */
const FULLSET = { id: 'artcraft-fullset', code: 'BD-ARTCRAFT-FULLSET', en: 'ArtCraft', cn: '开源创作套件 · 13 个应用', grid: true };

const argv = process.argv.slice(2);
const UPLOAD = argv.includes('--upload');
const want = argv.filter((a) => !a.startsWith('-'));

const accents = JSON.parse(fs.readFileSync(path.join(ASSETS, 'accents.json'), 'utf8'));
const fileOf = (id) => {
  // 「套件」没有自己的图标/截图，借用 ArtCraft 主图标（它本身就是套件的入口）
  const key = fs.existsSync(path.join(ASSETS, id)) ? id : 'artcraft';
  const d = path.join(ASSETS, key);
  if (!fs.existsSync(d)) return { icon: null, shot: null };
  const ls = fs.readdirSync(d);
  const shotName = ls.find((f) => f.startsWith('shot.'));
  return {
    icon: ls.includes('icon.png') ? path.join(d, 'icon.png') : null,
    shot: shotName ? path.join(d, shotName) : null,
  };
};

async function shoot(html, pngPath) {
  const htmlPath = pngPath.replace(/\.png$/, '.html');
  fs.writeFileSync(htmlPath, `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head><body style="margin:0">${html}</body></html>`, 'utf8');
  await exec(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--allow-file-access-from-files',
    `--window-size=${SIZE},${SIZE}`, `--screenshot=${pngPath}`, pathToFileURL(htmlPath).href,
  ], { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
  if (!fs.existsSync(pngPath)) throw new Error('Chrome 未产出截图');
  return pngPath;
}

const uri = (p) => encodeURI(p);

fs.mkdirSync(OUT, { recursive: true });
const jobs = [...APPS, FULLSET].filter((a) => !want.length || want.includes(a.id) || want.includes(a.code));
if (!jobs.length) { console.error('没有匹配的 app'); process.exit(1); }

console.log(`ArtCraft 商品图重制　后缀 -${TAG}　${jobs.length} 张${UPLOAD ? '　【渲染 + 上传 + 回填】' : '　【仅渲染】'}\n`);

let store = null;
if (UPLOAD) {
  store = JSON.parse(fs.readFileSync(DRAFTS, 'utf8'));
  const { uploadImage, mediaReady } = await import('../packages/xgj-admin/src/media');
  // ⚠️ mediaReady() 是**同步**函数、返回 { ready, missing } 对象，不是 promise；
  //    写成 `if (!(await mediaReady()))` 会永远为假（对象恒真）→ 配置错了也照跑。
  const mr = mediaReady();
  if (!mr.ready) { console.error(`❌ 图床不可用，缺少：${mr.missing.join('、')}`); process.exit(1); }

  let ok = 0, failed = 0;
  for (const a of jobs) {
    const { icon, shot } = fileOf(a.id);
    if (!icon || (!shot && !a.grid)) { console.log(`  ⚠️ ${a.id} 素材缺失，跳过`); failed++; continue; }
    const grid = a.grid ? APPS.map((x) => uri(fileOf(x.id).icon)).filter(Boolean) : null;
    const png = path.join(OUT, `${a.code}-${TAG}.png`);
    await shoot(renderArtcraftCard({ icon: uri(icon), shot: shot && uri(shot), grid, en: a.en, cn: a.cn, accent: accents[a.id] }), png);
    const up = await uploadImage(png, `${a.code.toLowerCase().replace(/^bd-/, '')}-${TAG}.png`);
    const entry = store[a.id];
    if (!entry) { console.log(`  ⚠️ ${a.id} 资源条目不存在，图已上传但未回填：${up.url}`); failed++; continue; }
    entry.cover_images = [up.url];
    const draftPath = path.join(ROOT, 'drafts', `${a.code}.json`);
    if (fs.existsSync(draftPath)) {
      const dr = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
      if (dr.publish_shop?.[0]) dr.publish_shop[0].images = [up.url];
      fs.writeFileSync(draftPath, JSON.stringify(dr, null, 2) + '\n', 'utf8');
    }
    console.log(`  ✅ ${a.code.padEnd(22)} ${(fs.statSync(png).size / 1024).toFixed(0).padStart(4)} KB → ${up.url}`);
    ok++;
  }
  fs.writeFileSync(DRAFTS, JSON.stringify(store, null, 2) + '\n', 'utf8');
  console.log(`\n上传回填 ✅${ok} ❌${failed}`);
  process.exit(0);
}

for (const a of jobs) {
  const { icon, shot } = fileOf(a.id);
  if (!icon || (!shot && !a.grid)) { console.log(`  ⚠️ ${a.id} 素材缺失（icon=${!!icon} shot=${!!shot}）`); continue; }
  const grid = a.grid ? APPS.map((x) => uri(fileOf(x.id).icon)).filter(Boolean) : null;
  const png = path.join(OUT, `${a.code}-${TAG}.png`);
  try {
    await shoot(renderArtcraftCard({ icon: uri(icon), shot: shot && uri(shot), grid, en: a.en, cn: a.cn, accent: accents[a.id] }), png);
    console.log(`  ✅ ${a.code.padEnd(22)} ${(fs.statSync(png).size / 1024).toFixed(0).padStart(4)} KB  accent=${accents[a.id]}`);
  } catch (e) {
    console.log(`  ❌ ${a.code} 失败：${String(e.message).split('\n')[0].slice(0, 90)}`);
  }
}
console.log(`\n产物：${path.relative(ROOT, OUT)}/`);
