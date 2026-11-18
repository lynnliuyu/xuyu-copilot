#!/usr/bin/env node
/**
 * 上架前体检（**本地图片**版）—— 在上传图床之前先扫一遍，别把违规图传上去。
 *
 * 复用 `scripts/lib/preflight.mjs` 的同一套规则（judgeImage），
 * 所以「本地扫」与「线上扫」（npm run preflight）判定完全一致，不会各写一份漂移。
 *
 * 用法：
 *   npx tsx scripts/preflight-local.mjs out/artcraft-cards/*.png
 *   npx tsx scripts/preflight-local.mjs --json out/artcraft-cards/BD-FIGCRAFT-v2.png
 *
 * 退出码：有 block 级 → 1。
 * 引擎与覆盖率同 `npm run preflight`（macOS → Vision，Linux → tesseract）。
 */
import { readImage, engineName, capabilities as engineCapabilities } from './lib/ocr.mjs';
import { judgeImage } from './lib/preflight.mjs';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const files = argv.filter((a) => !a.startsWith('-'));
if (!files.length) {
  console.error('用法：npx tsx scripts/preflight-local.mjs <图片...>');
  process.exit(2);
}

const cap = await engineCapabilities();
if (!AS_JSON) {
  console.log(`\n本地图片体检　引擎 ${engineName()}　①OCR ${cap.ocr ? '✔' : '✘'}　②分类 ${cap.labels ? '✔' : '✘'}　③肤色 ${cap.skin ? '✔' : '✘'}`);
  if (cap.note) console.log(`  ⚠️ ${cap.note}`);
  console.log();
}

const out = [];
for (const f of files) {
  if (!fs.existsSync(f)) { out.push({ file: f, error: '文件不存在' }); continue; }
  const scan = await readImage(f);
  const j = judgeImage(scan);
  out.push({ file: f, texts: (scan.texts || []).slice(0, 6), block: j.block, warn: j.warn });
  if (!AS_JSON) {
    const mark = j.block.length ? '\x1b[31m⛔\x1b[0m' : j.warn.length ? '\x1b[33m⚠️\x1b[0m' : '\x1b[32m✅\x1b[0m';
    console.log(`${mark} ${f.split('/').pop()}`);
    for (const x of j.block) console.log(`     \x1b[31m✗ ${x}\x1b[0m`);
    for (const x of j.warn) console.log(`     \x1b[2m· ${x}\x1b[0m`);
  }
}

const blocks = out.filter((r) => r.block?.length).length;
const warns = out.filter((r) => !r.block?.length && r.warn?.length).length;
if (AS_JSON) {
  console.log(JSON.stringify({ engine: engineName(), coverage: { ocr: cap.ocr, labels: cap.labels, skin: cap.skin }, blocks, warns, results: out }, null, 2));
} else {
  console.log(`\n汇总：检查 ${files.length}　硬拦截 ${blocks}　疑似 ${warns}　通过 ${files.length - blocks - warns}\n`);
}
process.exit(blocks ? 1 : 0);
