#!/usr/bin/env node
/**
 * 出「缺真图」清单：站上哪些条目现在用的是**程序生成的占位封面**，需要补真图。
 *
 *   判据：node.cover 指向 media/curated/（生成占位）而不是 media/covers|previews（真图）
 *   产出：docs/资源站-缺图清单.md  +  out/缺图清单.csv
 *
 * 用法：node scripts/netdisk-need-images.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = fs.readFileSync(path.join(ROOT, 'netdisk-site', 'data.js'), 'utf8');
const d = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));

const nodes = [];
(function walk(ns, trail) {
  for (const n of ns) {
    nodes.push({ ...n, _trail: trail });
    walk(n.children || [], [...trail, n.title]);
  }
})(d.tree, []);

const isReal = (c) => c && (c.startsWith('media/covers/') || c.startsWith('media/previews/') || c.startsWith('media/inbox/'));
// 判据改成「**目录节点**还用着生成占位图（或干脆没图）」——比只看 node.resource 更贴合实际
const res = nodes.filter((n) => n.dir && (String(n.cover || '').startsWith('media/curated/') || (!n.cover && !n.icon)));
const needCover = res;
// 「什么都没有」才算连图标也缺 —— 3D/Blender 那批靠封面展示，本来就不需要图标
const needIcon = needCover.filter((n) => !n.icon);

const rows = needCover
  .sort((a, b) => (a._trail[0] || '').localeCompare(b._trail[0] || '', 'zh'))
  .map((n) => ({
    cat: n._trail[0] || '',
    name: n.title,
    path: n.path,
    size: n.sizeText || '',
    hasIcon: n.icon ? '有' : '无',
  }));

// CSV
const csv = ['分类,名称,网盘路径,体积,已有图标', ...rows.map((r) =>
  [r.cat, r.name, r.path, r.size, r.hasIcon].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
fs.writeFileSync(path.join(ROOT, 'out', '缺图清单.csv'), csv, 'utf8');

// Markdown
const byCat = new Map();
for (const r of rows) {
  if (!byCat.has(r.cat)) byCat.set(r.cat, []);
  byCat.get(r.cat).push(r);
}
const md = [
  '# 资源站 · 缺真图清单',
  '',
  `> 生成时间 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}　·　由 \`npm run need:images\` 生成`,
  '',
  '站上这些条目现在用的是**程序生成的渐变占位封面**（`media/curated/*.svg`），不是真实截图/官方图。',
  '补图后把图片按 **条目名** 命名放进 `assets/_shared/cover-inbox/<网盘目录名>/`，我接进站点。',
  '',
  `合计 **${rows.length}** 个条目需要真图（共 ${res.length} 个资源条目，${res.length - rows.length} 个已有真图）。`,
  '',
];
for (const [cat, list] of [...byCat.entries()].sort()) {
  md.push(`## ${cat}（${list.length}）`, '', '| 名称 | 体积 | 已有图标 | 网盘目录 |', '|---|---|---|---|');
  for (const r of list) md.push(`| ${r.name} | ${r.size} | ${r.hasIcon} | \`${r.path}\` |`);
  md.push('');
}
if (needIcon.length) {
  md.push('## 连图标也没有', '', ...needIcon.map((n) => `- ${n._trail.join(' / ')} → ${n.title}`), '');
}
fs.writeFileSync(path.join(ROOT, 'docs', '资源站-缺图清单.md'), md.join('\n'), 'utf8');

console.log(`资源条目 ${res.length}　已有真图 ${res.length - rows.length}　缺真图 ${rows.length}`);
for (const [cat, list] of [...byCat.entries()].sort()) console.log(`   ${cat.padEnd(12)} ${list.length}`);
console.log('\n→ docs/资源站-缺图清单.md　+　out/缺图清单.csv');
