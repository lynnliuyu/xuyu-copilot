#!/usr/bin/env node
/**
 * 为资源站准备图片素材（卡片墙要「有图标有图片」）。
 *
 *   1. 封面：3D模型 / Blender建模 的产品目录 → 按 ID 前段匹配本机已采集的封面图，
 *      拷到 netdisk-site/media/covers/<key>.jpg
 *   2. 图标：软件类 → 从本机官方安装包（.dmg 挂载 / .zip 解压）里提取 .app 的 .icns，
 *      用 sips 转成 256px PNG → netdisk-site/media/icons/<id>.png
 *   3. 产出 netdisk-site/media.json：{ covers: {网盘路径: 相对图}, icons: {manifest id: 相对图} }
 *
 * 用法：npm run media:netdisk
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'out', 'netdisk-index.json');
const MANIFEST = path.join(ROOT, 'assets', 'free-software', 'manifest.json');
const DL_DIR = path.join(ROOT, 'assets', 'free-software', 'downloads');
const SITE = path.join(ROOT, 'netdisk-site');
const MEDIA = path.join(SITE, 'media');
const COVER_OUT = path.join(MEDIA, 'covers');
const ICON_OUT = path.join(MEDIA, 'icons');

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

// ⚠️ 必须用 `covers-clean`（已用 clean-covers.py 抹掉右下角网址水印的中值滤波版本），
//    用 `covers` 会把带水印的原图渲染到站点上。
const SOURCES = [
  { netdiskCat: 'Blender建模', src: 'assets/gfxcamp-blender/covers-clean', prefix: 'b' },
  { netdiskCat: '3D模型', src: 'assets/gfxcamp-3dmodel/covers-clean', prefix: 'm' },
];

/* ---------------------------------------------------------------- 1. 封面 */
function buildCovers() {
  const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  fs.mkdirSync(COVER_OUT, { recursive: true });
  const map = {};
  let total = 0;

  for (const s of SOURCES) {
    const dir = path.join(ROOT, s.src);
    if (!fs.existsSync(dir)) { console.log(`  ⚠️ 缺封面源：${s.src}`); continue; }
    const byId = new Map();
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('.')) continue;
      const id = f.split('-')[0];
      if (!byId.has(id)) byId.set(id, f);
    }

    const cat = idx.tree.find((n) => n.name === s.netdiskCat);
    if (!cat) { console.log(`  ⚠️ 网盘里没有类目：${s.netdiskCat}`); continue; }

    let copied = 0;
    let missing = 0;
    for (const p of cat.children || []) {
      const id = p.name.split('-')[0];
      const file = byId.get(id);
      if (!file) { missing += 1; continue; }
      const key = `${s.prefix}-${id}.jpg`;
      const dest = path.join(COVER_OUT, key);
      if (!fs.existsSync(dest)) fs.copyFileSync(path.join(dir, file), dest);
      map[p.path] = `media/covers/${key}`;
      copied += 1;
    }
    total += copied;
    console.log(`  ${s.netdiskCat}：匹配封面 ${copied} 张${missing ? `（缺 ${missing}）` : ''}`);
  }
  return { map, copied: total };
}

/* ---------------------------------------------------------------- 2. 图标 */
function findIcnsInApp(appDir) {
  const res = path.join(appDir, 'Contents', 'Resources');
  if (!fs.existsSync(res)) return null;
  const icns = fs.readdirSync(res).filter((f) => f.toLowerCase().endsWith('.icns'));
  if (!icns.length) return null;
  // 多个时取最大的那个（通常是主图标）
  icns.sort((a, b) => fs.statSync(path.join(res, b)).size - fs.statSync(path.join(res, a)).size);
  return path.join(res, icns[0]);
}

function iconFromZip(zip, out) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ico-'));
  try {
    const list = sh('unzip', ['-Z1', zip]).split('\n');
    const app = list.find((l) => /\.app\/Contents\/MacOS\//.test(l));
    if (!app) return null;
    const appDir = app.slice(0, app.indexOf('.app/') + 4);
    const icnsEntry = list.find((l) => l.startsWith(appDir + '/Contents/Resources/') && /\.icns$/i.test(l));
    if (!icnsEntry) return null;
    sh('unzip', ['-o', '-q', zip, icnsEntry, '-d', tmp]);
    return sh('sips', ['-s', 'format', 'png', '-Z', '256', path.join(tmp, icnsEntry), '--out', out]).length >= 0
      ? out : null;
  } catch { return null; } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function iconFromDmg(dmg, out) {
  const mp = fs.mkdtempSync(path.join(os.tmpdir(), 'mnt-'));
  let attached = false;
  try {
    sh('hdiutil', ['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', mp, dmg]);
    attached = true;
    const apps = fs.readdirSync(mp).filter((f) => f.endsWith('.app'));
    if (!apps.length) return null;
    const icns = findIcnsInApp(path.join(mp, apps[0]));
    if (!icns) return null;
    const tmpPng = path.join(os.tmpdir(), `ico-${Date.now()}.png`);
    sh('sips', ['-s', 'format', 'png', '-Z', '256', icns, '--out', tmpPng]);
    fs.copyFileSync(tmpPng, out);
    fs.rmSync(tmpPng, { force: true });
    return out;
  } catch { return null; } finally {
    if (attached) { try { sh('hdiutil', ['detach', mp, '-quiet']); } catch {} }
    fs.rmSync(mp, { recursive: true, force: true });
  }
}

function buildIcons() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  fs.mkdirSync(ICON_OUT, { recursive: true });
  const map = {};
  const sw = idx.tree.find((n) => n.name === '软件');
  const folders = (sw?.children || []).map((c) => c.name);

  // 本地包路径以 out/free-software.json 为准（那里有 id → local 的确定映射），别猜文件名
  const localById = new Map();
  const RESULT = path.join(ROOT, 'out', 'free-software.json');
  if (fs.existsSync(RESULT)) {
    for (const r of JSON.parse(fs.readFileSync(RESULT, 'utf8')).items || []) {
      if (r.status === 'downloaded' && r.local) localById.set(r.id, r.local);
    }
  }

  const pending = [];
  for (const it of manifest.items) {
    if (!folders.includes(it.name)) continue;   // 只做网盘上真有的
    const src = localById.get(it.id);
    if (!src || !fs.existsSync(src)) { pending.push(it); continue; }
    const out = path.join(ICON_OUT, `${it.id}.png`);
    const r = /\.zip$/i.test(src) ? iconFromZip(src, out) : iconFromDmg(src, out);
    if (r) { map[it.id] = `media/icons/${it.id}.png`; console.log(`  ✅ ${it.name}`); }
    else { console.log(`  ⚠️ ${it.name}：包里没有 .icns（可能用 Assets.car），改用占位块`); pending.push(it); }
  }

  // 兜一下：同名系列（如 MediaInfo CLI ← MediaInfo GUI）直接借用同族图标
  for (const it of pending) {
    const donor = manifest.items.find((x) => x.id !== it.id && x.name.startsWith(it.name) && map[x.id]);
    if (!donor) continue;
    const out = path.join(ICON_OUT, `${it.id}.png`);
    fs.copyFileSync(path.join(SITE, map[donor.id]), out);
    map[it.id] = `media/icons/${it.id}.png`;
    console.log(`  ↗︎ ${it.name}：借用 ${donor.name} 的图标`);
  }
  return map;
}

/* ---------------------------------------------------------------- 主流程 */
console.log('══════ 准备资源站图片素材 ══════');
console.log('— 封面 —');
const cov = buildCovers();
console.log('— App 图标 —');
const ico = buildIcons();

fs.mkdirSync(MEDIA, { recursive: true });
fs.writeFileSync(
  path.join(SITE, 'media.json'),
  JSON.stringify({ generated_at: new Date().toISOString(), covers: cov.map, icons: ico }, null, 1),
  'utf8',
);
console.log(`\n封面 ${cov.copied} 张　图标 ${Object.keys(ico).length} 个　→ netdisk-site/media.json`);
