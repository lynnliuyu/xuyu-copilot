#!/usr/bin/env node
/**
 * 「收图」：把搜集到的图片接进站点。
 *
 * 约定：图片放在 `assets/_shared/cover-inbox/<网盘目录名>/` 下（一个条目一个文件夹）
 *      文件名随意，扩展名 .jpg/.jpeg/.png/.webp；同名多张时按文件名排序取第一张当封面，
 *      其余存进站点（可用于以后的图集）。
 *
 *   匹配方式：**按目录名**对上网盘路径（先精确匹配目录名，再退化为去数字前缀后匹配）。
 *   产出：拷图到 netdisk-site/media/inbox/<key>.<ext>，并把 cover 写进 netdisk-site/media.json
 *        的 curated[网盘路径].cover（生成器会优先使用）。**只新增，不动已有条目**。
 *
 * 用法：npm run cover:inbox [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INBOX = path.join(ROOT, 'assets', '_shared', 'cover-inbox');
const SITE = path.join(ROOT, 'netdisk-site');
const OUTDIR = path.join(SITE, 'media', 'inbox');
const MEDIA = path.join(SITE, 'media.json');
const DRY = process.argv.includes('--dry');
const EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

if (!fs.existsSync(INBOX)) {
  console.error(`❌ 还没有收图目录：${path.relative(ROOT, INBOX)}`);
  process.exit(1);
}

// 网盘目录名 → 路径（用于按名匹配）
const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'out', 'netdisk-index.json'), 'utf8'));
const byName = new Map();
(function walk(ns) {
  for (const n of ns) {
    if (n.dir) {
      const clean = n.name.replace(/^\d{3,}[-_]\s*/, '');
      for (const k of [n.name, clean]) if (k && !byName.has(k)) byName.set(k, n.path);
      walk(n.children || []);
    }
  }
})(idx.tree);

const media = fs.existsSync(MEDIA) ? JSON.parse(fs.readFileSync(MEDIA, 'utf8')) : {};
media.curated ||= {};
if (!DRY) fs.mkdirSync(OUTDIR, { recursive: true });

const slug = (s) => s.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 60);
let ok = 0;
let miss = 0;

for (const entry of fs.readdirSync(INBOX)) {
  if (entry.startsWith('.')) continue;
  const dir = path.join(INBOX, entry);
  if (!fs.statSync(dir).isDirectory()) continue;
  const imgs = fs.readdirSync(dir).filter((f) => EXTS.includes(path.extname(f).toLowerCase())).sort();
  if (!imgs.length) continue;

  const target = byName.get(entry);
  if (!target) {
    console.log(`  ⚠️ ${entry} —— 网盘里找不到同名目录，跳过`);
    miss += 1;
    continue;
  }
  const key = `${slug(path.basename(target))}-${ok}${path.extname(imgs[0]).toLowerCase()}`;
  if (!DRY) {
    fs.copyFileSync(path.join(dir, imgs[0]), path.join(OUTDIR, key));
    media.curated[target] = { ...(media.curated[target] || {}), cover: `media/inbox/${key}` };
  }
  console.log(`  ✅ ${entry}　${imgs.length} 张 → ${target}　封面: ${imgs[0]}`);
  ok += 1;
}

if (!DRY && ok) fs.writeFileSync(MEDIA, JSON.stringify(media, null, 1), 'utf8');
console.log(`\n接入 ${ok} 个条目${miss ? `　未匹配 ${miss} 个` : ''}${DRY ? '　【dry-run，未写入】' : ''}`);
if (ok && !DRY) console.log('下一步：npm run site:netdisk 重建站点数据');
