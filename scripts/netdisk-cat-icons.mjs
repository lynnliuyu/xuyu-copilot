#!/usr/bin/env node
/**
 * 合成资源站的**分类卡片图标**：官方品牌图形 + 品牌色圆角方块。
 *
 *   输入：assets/_shared/brand-icons/*.svg   （官方图形，来源见该目录 SOURCES.md）
 *   输出：netdisk-site/media/cats/*.svg      （96×96 圆角方块 + 白色官方图形）
 *
 * 用官方图形而不是自己画的字形 —— 图形是各品牌官方发布的美术资源，
 * 我们只做「配色底 + 缩放居中」的合成，不做改形。
 *
 * 用法：npm run cat:icons
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'assets', '_shared', 'brand-icons');
const OUT = path.join(ROOT, 'netdisk-site', 'media', 'cats');

/** 分类图标表：输出名 → 官方图形 + 渐变色 + 可选角标 */
const TILES = [
  { out: 'blender.svg', brand: 'blender', g: ['#F9A03F', '#DE5F06'], badge: null },
  { out: 'blender-model.svg', brand: 'blender', g: ['#3EC5D8', '#0B7E92'], badge: 'cube' },
  { out: 'blender-plugin.svg', brand: 'blender', g: ['#9B7BF7', '#5B4BD6'], badge: 'plug' },
  { out: 'software.svg', brand: 'appstore', g: ['#818CF8', '#4338CA'], badge: null },
  { out: 'software-mac.svg', brand: 'apple', g: ['#4EB6F5', '#0A66A8'], badge: null },
  { out: 'software-win.svg', brand: 'windows', g: ['#2FD0BC', '#0B7C74'], badge: null },
  { out: 'browser-ext.svg', brand: 'chrome', g: ['#F270B4', '#7C3AED'], badge: null },
  { out: 'smarthome.svg', brand: 'homeassistant', g: ['#4FC3F7', '#0B6E9E'], badge: null },
  { out: 'android.svg', brand: 'android', g: ['#7BD88F', '#2E7D46'], badge: null },
];

/** 从官方 svg 里取出路径 d（都是 24×24 单路径） */
function brandPath(name) {
  const f = path.join(SRC, `${name}.svg`);
  if (!fs.existsSync(f)) throw new Error(`缺少品牌图形：assets/_shared/brand-icons/${name}.svg`);
  const svg = fs.readFileSync(f, 'utf8');
  const ds = [...svg.matchAll(/<path[^>]*?\sd="([^"]+)"/g)].map((m) => m[1]);
  if (!ds.length) throw new Error(`${name}.svg 里没找到 <path d>`);
  const rule = /fill-rule="evenodd"/.test(svg) ? ' fill-rule="evenodd"' : '';
  return ds.map((d) => `<path d="${d}"${rule}/>`).join('');
}

/** 角标：白底圆 + 深色小图形（用来区分共用同一个官方 logo 的子类） */
function badge(kind, color) {
  const cx = 72;
  const cy = 72;
  let g = '';
  if (kind === 'cube') {
    g = `<g fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round">
      <polygon points="${cx},${cy - 8.5} ${cx + 7.5},${cy - 4.2} ${cx},${cy} ${cx - 7.5},${cy - 4.2}"/>
      <polyline points="${cx - 7.5},${cy - 4.2} ${cx - 7.5},${cy + 4.2} ${cx},${cy + 8.5} ${cx + 7.5},${cy + 4.2} ${cx + 7.5},${cy - 4.2}"/>
      <line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy + 8.5}"/></g>`;
  } else if (kind === 'plug') {
    g = `<g fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round">
      <path d="M${cx - 3.6} ${cy - 4.2}v-3.6M${cx + 3.6} ${cy - 4.2}v-3.6"/>
      <rect x="${cx - 7}" y="${cy - 4.2}" width="14" height="10.5" rx="3.6" fill="${color}" stroke="none"/>
      <path d="M${cx} ${cy + 6.3}v3.6"/></g>`;
  }
  return `<circle cx="${cx}" cy="${cy}" r="14.5" fill="#fff" fill-opacity=".96"/>${g}`;
}

fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const t of TILES) {
  const mark = brandPath(t.brand);
  // 有角标时把官方图形缩小并往左上挪，给右下角标腾位置（避免两者贴到一起）
  const scale = t.badge ? 1.78 : 2.25;
  const size = 24 * scale;
  const ox = t.badge ? 15 : (96 - size) / 2;
  const oy = t.badge ? 13 : (96 - size) / 2;
  const id = `g${t.out.replace(/[^a-z]/gi, '')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96" role="img">
  <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${t.g[0]}"/><stop offset="1" stop-color="${t.g[1]}"/>
  </linearGradient></defs>
  <rect width="96" height="96" rx="22" fill="url(#${id})"/>
  <g transform="translate(${ox.toFixed(2)},${oy.toFixed(2)}) scale(${scale})" fill="#fff">${mark}</g>
  ${t.badge ? badge(t.badge, t.g[1]) : ''}
</svg>
`;
  fs.writeFileSync(path.join(OUT, t.out), svg, 'utf8');
  n += 1;
  console.log(`  ✅ ${t.out.padEnd(20)} ← ${t.brand}${t.badge ? `　角标:${t.badge}` : ''}`);
}
console.log(`\n共 ${n} 个分类图标 → ${path.relative(ROOT, OUT)}`);
