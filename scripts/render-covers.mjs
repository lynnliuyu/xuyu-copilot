#!/usr/bin/env node
/**
 * 通用商品封面渲染器 —— 渲染 C2 模板 → 上传图床 → 回填「资源条目」与「商品草稿」。
 *
 * 模板唯一实现在 `assets/_shared/card-c2.mjs`，本脚本只负责取数据与回填，
 * 所以 3D 模型与 Blender 插件共用同一套视觉，不会各自漂移。
 *
 * 用法（用 tsx 跑，因为要 import 管理端 TS 模块）：
 *   npx tsx scripts/render-covers.mjs --collector assets/gfxcamp-3dmodel --noun "3D 模型素材" --pending
 *   npx tsx scripts/render-covers.mjs --collector assets/gfxcamp-blender --noun "Blender 插件" --brand "繁梦空间 · 插件" --pending
 *   ... <资源id...>          只处理指定 id
 *   ... --render-only        只渲染到本地，不上传不回填
 *
 * `--pending` = 处理「沙箱已出链、但台账里还没有 product_id」的全部资源（即尚未上架的）。
 *
 * ⚠️ 文件名带 `-v2` 这类新后缀而不覆盖旧文件：闲鱼是**服务端抓图**，
 *    URL 不变时编辑商品很可能命中它的图片缓存、不重新抓取。
 *
 * ⚠️ 本脚本只改数据（草稿与资源条目），不碰线上商品。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectSoftware, chipHtml, wrapTitle, renderC2Html, SIZE } from '../assets/_shared/card-c2.mjs';
import { uploadImage, mediaReady } from '../packages/xgj-admin/src/media';

const exec = promisify(execFile);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = 'http://127.0.0.1:8790';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, dft) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : dft;
};

const COLLECTOR = valOf('--collector', '');
const NOUN = valOf('--noun', '素材');
const BRAND = valOf('--brand', '繁梦空间 · 模型');
const TAG = valOf('--tag', 'v2');
const RENDER_ONLY = has('--render-only');
const PENDING = has('--pending');
let IDS = argv.filter((a) => !a.startsWith('--') && a !== COLLECTOR && a !== NOUN && a !== BRAND && a !== TAG);

if (!COLLECTOR) {
  console.error('用法：npx tsx scripts/render-covers.mjs --collector <dir> --noun <词> [--pending | <id...>]');
  process.exit(1);
}
if (!IDS.length && !PENDING) {
  console.error('❌ 需要 --pending 或显式给一组资源 id');
  process.exit(1);
}
if (!RENDER_ONLY) {
  const r = mediaReady();
  if (!r.ready) {
    console.error(`❌ 图床未配置：${r.missing.join('、')}`);
    process.exit(1);
  }
}

const CROOT = path.resolve(PROJ, COLLECTOR);
const OUT = path.join(CROOT, 'out', 'refresh');
fs.mkdirSync(OUT, { recursive: true });

/* ---------------- 数据 ---------------- */
const rows = JSON.parse(fs.readFileSync(path.join(CROOT, 'resources.json'), 'utf8'));
const byId = new Map(rows.map((r) => [String(r.id), r]));
const detailFile = path.join(CROOT, 'data', 'detail.json');
const detailById = fs.existsSync(detailFile)
  ? new Map(JSON.parse(fs.readFileSync(detailFile, 'utf8')).map((x) => [String(x.id), x]))
  : new Map();
const cleanDir = path.join(CROOT, 'covers-clean');

const shares = JSON.parse(fs.readFileSync(path.join(CROOT, 'data', 'sandbox-share.json'), 'utf8'));

let listings = {};
try {
  listings = JSON.parse(fs.readFileSync(path.join(PROJ, 'drafts', '.listings.json'), 'utf8'));
} catch { /* 无台账 */ }
const storePath = path.join(PROJ, 'drafts', '.resources.json');
const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));

if (PENDING) {
  // 已出链、已建条目、但台账里还没有 product_id 的 —— 就是「待上架」那批
  IDS = Object.entries(shares)
    .filter(([, s]) => s.share_url && !s.invalid)
    .map(([id]) => String(id))
    .filter((id) => {
      const key = `gfx-${id}`;
      if (!store[key]) return false;
      const code = store[key].draft_code || `BD-GFX-${id}`;
      return !listings[code];
    });
}

if (!IDS.length) {
  console.log('没有需要渲染的资源（--pending 命中 0 个）。');
  process.exit(0);
}
console.log(`采集器 ${COLLECTOR}\n副标题用词「${NOUN}」　水印「${BRAND}」　后缀 -${TAG}　共 ${IDS.length} 个${RENDER_ONLY ? '　【仅渲染】' : ''}\n`);

async function shoot(html, pngPath) {
  const htmlPath = pngPath.replace(/\.png$/, '.html');
  fs.writeFileSync(
    htmlPath,
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head><body style="margin:0">${html}</body></html>`,
    'utf8',
  );
  await exec(
    CHROME,
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1',
     `--window-size=${SIZE},${SIZE}`, `--screenshot=${pngPath}`, pathToFileURL(htmlPath).href],
    { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (!fs.existsSync(pngPath)) throw new Error('Chrome 未产出截图');
  return pngPath;
}

/* ---------------- 执行 ---------------- */
// 回填改成批量落盘：每渲染完一个就更新内存里的 store，最后统一写一次，
// 避免 N 次读写同一文件（3D 模型 145 个、插件几百个时很明显）。
let storeDirty = false;
let ok = 0, failed = 0;
const done = [];
const errors = [];

for (const [i, id] of IDS.entries()) {
  const r = byId.get(id);
  if (!r) { console.log(`  ⚠️ 找不到资源 ${id}，跳过`); failed++; continue; }

  const cleanName = fs.existsSync(cleanDir) ? fs.readdirSync(cleanDir).find((f) => f.startsWith(`${id}-`)) : null;
  const imgPath = cleanName ? path.join(cleanDir, cleanName) : path.join(CROOT, r.cover_local || '');
  if (!fs.existsSync(imgPath)) { console.log(`  ⚠️ ${id} 封面缺失：${imgPath}`); failed++; errors.push(`${id}: 封面缺失`); continue; }

  const nVer = (r.down_links || []).length;
  const sw = detectSoftware(r, detailById.get(id));
  const lines = wrapTitle(r.title);
  let png;
  try {
    png = await shoot(
      renderC2Html({
        img: encodeURI(imgPath),
        lines,
        sub: nVer > 1 ? `${NOUN} · ${nVer} 个版本可选` : NOUN,
        chips: chipHtml(sw),
        brand: BRAND,
        size: lines.length > 1 ? 56 : 64,
        badge: '自动发货',
        foot: '拍下后自动发百度网盘链接 · 请及时转存',
      }),
      path.join(OUT, `gfx-${id}-${TAG}.png`),
    );
  } catch (e) {
    console.log(`  ❌ ${id} 渲染失败：${String(e.message).split('\n')[0].slice(0, 80)}`);
    failed++; errors.push(`${id}: 渲染失败`);
    continue;
  }

  const kb = (fs.statSync(png).size / 1024).toFixed(0);
  const label = `${String(i + 1).padStart(3)}/${IDS.length}  ${id}  ${r.title.slice(0, 34)}`;
  console.log(`  ✅ ${label}  ${kb} KB  [${sw.map((s) => s.name).join('/') || '无'}]`);

  if (RENDER_ONLY) { done.push({ id, png }); ok++; continue; }

  try {
    const up = await uploadImage(png, `gfx-${id}-${TAG}.png`);
    const key = `gfx-${id}`;
    const code = store[key]?.draft_code || `BD-GFX-${id}`;
    if (store[key]) {
      store[key].cover_images = [up.url];
      store[key].updated_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
      storeDirty = true;
    }
    const draftPath = path.join(PROJ, 'drafts', `${code}.json`);
    if (fs.existsSync(draftPath)) {
      const d = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
      for (const shop of d.publish_shop ?? []) shop.images = [up.url];
      fs.writeFileSync(draftPath, JSON.stringify(d, null, 2) + '\n');
    }
    done.push({ id, url: up.url });
    ok++;
  } catch (e) {
    console.log(`     ❌ 上传/回填失败：${String(e.message).split('\n')[0].slice(0, 90)}`);
    failed++; errors.push(`${id}: 上传失败`);
  }
}

if (storeDirty) {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n');
  console.log('\n已回填 drafts/.resources.json 的 cover_images');
}

console.log(`\n──────── 完成：成功 ${ok} · 失败 ${failed} ────────`);
if (errors.length) {
  console.log('失败明细（前 10 条）：');
  for (const e of errors.slice(0, 10)) console.log('  ' + e);
}
console.log(`产物目录：${OUT}`);
