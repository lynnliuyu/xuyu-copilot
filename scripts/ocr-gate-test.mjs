/**
 * 体检闸门的**跨引擎对照测试** —— 换 OCR 引擎前必须跑这一条。
 *
 * 为什么必须有它：换 OCR 引擎等于换掉闸门的眼睛。只有确认「同一条违规
 * 在两个引擎下都被判为 block」，换引擎才是安全的。
 * 参照物是 2026-10-08 那次封号 —— 封面图里带「GPT」字样，纯文本扫描挡不住。
 *
 * 用法：
 *   node scripts/ocr-gate-test.mjs                    # 用当前平台的引擎
 *   PREFLIGHT_OCR=vision    node scripts/ocr-gate-test.mjs
 *   PREFLIGHT_OCR=tesseract node scripts/ocr-gate-test.mjs
 *   容器里：docker compose run --rm --no-deps admin node scripts/ocr-gate-test.mjs
 *
 * 退出码：0 = 闸门生效（判出违规）；1 = 漏判（**不要上架，先查引擎**）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.APP_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.OUT_DIR || path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });

const { readImage, engineName, capabilities } = await import(`${ROOT}/scripts/lib/ocr.mjs`);
const { judgeImage } = await import(`${ROOT}/scripts/lib/preflight.mjs`);

const png = path.join(OUT, 'ocr-gate-test.png');

// 用项目自带的 jimp 造图 —— 不引入新依赖，也让测试可复现
if (!fs.existsSync(png)) {
  const m = await import('jimp');
  const Jimp = m.default ?? m;
  const img = new Jimp(760, 240, 0xffffffff);
  const font = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
  img.print(font, 24, 60, 'ChatGPT  GPT-4o');
  img.print(font, 24, 140, 'StableDiffusion  Midjourney');
  await img.writeAsync(png);
  console.log('已生成测试图:', png);
}

const cap = await capabilities();
console.log('engine =', engineName(), JSON.stringify(cap));

const r = await readImage(png);
const j = judgeImage(r);
console.log('读到的文字:', JSON.stringify(r.texts));
console.log('BLOCK:', JSON.stringify(j.block, null, 2));
console.log('结论:', j.block.length ? '✅ 闸门生效（判为违规）' : '❌ 闸门失效（漏判）');
process.exit(j.block.length ? 0 : 1);
