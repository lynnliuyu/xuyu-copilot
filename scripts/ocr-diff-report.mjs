/**
 * 比对两个引擎的测量结果（由 scripts/ocr-diff.mjs 产出）。
 *
 * 读法（按危险程度排序）：
 *   ① 漏判（Vision 拦了、tesseract 没拦）→ **危险**，等于闸门变松
 *   ② 多判（tesseract 拦了、Vision 没拦）→ 保守，可接受
 *   ③ 文字条数差          → 召回能力差异，参考
 *   ④ 肤色占比差          → 应接近 0（两边都是同一套纯数学）
 *
 * 用法：node scripts/ocr-diff-report.mjs out/ocr-diff-vision.json out/ocr-diff-tesseract.json
 */
import fs from 'node:fs';

const [fa, fb] = process.argv.slice(2);
if (!fa || !fb) {
  console.error('用法：node scripts/ocr-diff-report.mjs <A.json> <B.json>');
  process.exit(2);
}
const A = JSON.parse(fs.readFileSync(fa, 'utf8'));
const B = JSON.parse(fs.readFileSync(fb, 'utf8'));
const am = new Map(A.results.map((r) => [r.f, r]));
const bm = new Map(B.results.map((r) => [r.f, r]));
const files = [...am.keys()].filter((f) => bm.has(f));

const norm = (ts) =>
  new Set(ts.filter((t) => t.trim()).map((t) => t.toUpperCase().replace(/[^A-Z0-9]/g, '')));

console.log(`${A.engine}: ${A.count} 张 ${(A.ms / 1000).toFixed(1)}s`);
console.log(`${B.engine}: ${B.count} 张 ${(B.ms / 1000).toFixed(1)}s`);
console.log(`可比对: ${files.length} 张\n`);

let miss = 0;
let over = 0;
let textSame = 0;
let textBothEmpty = 0;
const diffs = [];
for (const f of files) {
  const a = new Set(am.get(f).block);
  const b = new Set(bm.get(f).block);
  const m = [...a].filter((x) => !b.has(x));
  const o = [...b].filter((x) => !a.has(x));
  if (m.length) miss++;
  if (o.length) over++;
  if (m.length || o.length) {
    diffs.push(`  ${f}\n    A: ${[...a].join(',') || '—'}\n    B: ${[...b].join(',') || '—'}`);
  }
  const ta = norm(am.get(f).texts);
  const tb = norm(bm.get(f).texts);
  if (!ta.size && !tb.size) textBothEmpty++;
  else if (ta.size === tb.size && [...ta].every((x) => tb.has(x))) textSame++;
}
const label = (e) => (e === 'vision' ? 'Vision' : 'tesseract');
console.log(`── ① block 层面 ──`);
console.log(`  A(${label(A.engine)}) 有 block: ${files.filter((f) => am.get(f).block.length).length} 张`);
console.log(`  B(${label(B.engine)}) 有 block: ${files.filter((f) => bm.get(f).block.length).length} 张`);
console.log(`  ⚠️ 漏判（A 有、B 无）: ${miss} 张`);
console.log(`  ＋多判（B 有、A 无）: ${over} 张`);
if (diffs.length) console.log(diffs.join('\n'));

console.log(`\n── ② 文字层面 ──`);
console.log(`  完全相同: ${textSame} 张   两侧都无文字: ${textBothEmpty} 张   有差异: ${files.length - textSame - textBothEmpty} 张`);

const errA = files.filter((f) => am.get(f).err).length;
const errB = files.filter((f) => bm.get(f).err).length;
console.log(`\n── ③ 读取失败 ──\n  A ${errA} 张   B ${errB} 张`);

const ds = files.map((f) => Math.abs(am.get(f).skin - bm.get(f).skin));
console.log(`\n── ④ 肤色占比 ──`);
console.log(`  平均绝对差 ${(ds.reduce((s, x) => s + x, 0) / ds.length).toFixed(4)}   最大 ${Math.max(...ds).toFixed(4)}`);

process.exit(miss > 0 ? 1 : 0);
