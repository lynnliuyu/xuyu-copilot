/**
 * 跨引擎差异测量：同一批图，分别用 macOS Vision 与 Linux tesseract 跑一遍，落 JSON 供比对。
 *
 * 目的不是「证明一样」，而是**量出不一样的地方有多大** —— 尤其是 block（硬拦截）层面
 * 有没有漏判。warn 层面（图像分类 / 肤色）的差异是已知且可接受的：
 * tesseract 根本没有图像分类能力。
 *
 * 两个引擎各跑一次，再用 scripts/ocr-diff-report 比对：
 *   本机（Vision）:   node scripts/ocr-diff.mjs
 *   容器（tesseract）: docker compose run --rm --no-deps -v "$PWD/out/.preflight/img:/imgs:ro" \
 *                       -e IMG_DIR=/imgs -e OUT_JSON=/work/ocr-diff-tesseract.json admin \
 *                       node scripts/ocr-diff.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.APP_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.env.IMG_DIR || path.join(ROOT, 'out', '.preflight', 'img');
const LIMIT = Number(process.env.LIMIT || 40);

const { readImage, engineName } = await import(`${ROOT}/scripts/lib/ocr.mjs`);
const { judgeImage, RULES } = await import(`${ROOT}/scripts/lib/preflight.mjs`);

if (!fs.existsSync(DIR)) {
  console.error(`❌ 找不到图片目录：${DIR}\n   （先跑一次 npm run preflight 让它把商品图抓下来）`);
  process.exit(2);
}

const files = fs
  .readdirSync(DIR)
  .filter((f) => /\.(png|jpe?g)$/i.test(f))
  .sort()
  .slice(0, LIMIT);

const out = { engine: engineName(), count: files.length, results: [] };
const t0 = Date.now();
for (const f of files) {
  const r = await readImage(path.join(DIR, f));
  const j = judgeImage(r);
  out.results.push({
    f,
    texts: r.texts || [],
    err: r.error || null,
    labels: (r.labels || []).map((l) => l.id), // 只留 id，控制体积
    skin: Number((r.skinRatio || 0).toFixed(4)),
    skinCenter: Number((r.skinCenter || 0).toFixed(4)),
    // 从「命中「GPT」」里抠出 token，便于按集合比较
    block: (j.block || [])
      .map((s) => (String(s).match(/命中「(.+?)」/) || [])[1])
      .filter(Boolean)
      .sort(),
    warn: (j.warn || []).length,
  });
}
out.ms = Date.now() - t0;
out.ocr_tokens = RULES.image.ocr_tokens;

const dest = process.env.OUT_JSON || path.join(ROOT, 'out', `ocr-diff-${out.engine}.json`);
fs.writeFileSync(dest, JSON.stringify(out, null, 1));
console.log(
  `${out.engine}: ${out.count} 张，用时 ${(out.ms / 1000).toFixed(1)}s（${(out.ms / out.count).toFixed(0)}ms/张）→ ${dest}`,
);
