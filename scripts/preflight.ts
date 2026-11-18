#!/usr/bin/env node
/**
 * 上架前体检（命令行）—— **文字 + 图片**双重违禁内容检查。
 *
 * 核心逻辑在 `scripts/lib/preflight.mjs`（发布脚本也要用，规则只留一份）。
 *
 * ── 为什么必须做（2026-10-08 真实事故）
 * 一个 Blender 插件的**封面图里有「GPT」字样**，被闲鱼判定违规，**账号被封控**。
 * 纯文本扫描挡不住 —— 违禁词在**图里**，只能靠 OCR 读出来。
 * 同类雷区：**过度暴露的女性图片**。
 *
 * ── 用法
 *   npm run preflight                    检查所有「未上架」的草稿
 *   npm run preflight -- --all           全部草稿
 *   npm run preflight -- BD-DIPLAY       指定草稿（可给多个）
 *   npm run preflight -- --text-only     只查文字（快，不下载图）
 *   npm run preflight -- --images-only   只查图
 *   npm run preflight -- --json          输出 JSON（给流水线消费）
 *
 * 退出码：发现 block 级问题 → 1，可直接当发布闸门。
 * 词表：assets/_shared/banned-words.json　缓存：out/.preflight/
 *
 * ── 图片引擎是可移植的（见 scripts/lib/ocr.mjs）
 *   macOS → Vision（swiftc 现编 vision-scan.swift，三项能力齐全）
 *   Linux → tesseract（镜像里已装；②图像分类无替代实现，运行时会明确报出覆盖率）
 *   覆盖：PREFLIGHT_OCR=vision|tesseract|off
 */
import {
  checkDraft, cardTextOf, allCodes, loadListings, capabilities, saveResults,
} from './lib/preflight.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const ALL = has('--all');
const TEXT_ONLY = has('--text-only');
const IMAGES_ONLY = has('--images-only');
const AS_JSON = has('--json');
const CODES = argv.filter((a) => !a.startsWith('--') && /^BD-/i.test(a));

const line = (s = '') => process.stdout.write(s + '\n');
const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

/* ---------------- 选目标 ---------------- */
const listings = loadListings();
let codes = CODES.length ? CODES : allCodes();
if (!ALL && !CODES.length) {
  codes = codes.filter((c) => {
    const st = listings[c]?.state;
    return !listings[c] || st === 'draft' || st === 'pending_review' || st === 'unknown';
  });
}
codes.sort();

if (!AS_JSON) {
  line('');
  line(b('══════ 上架前体检 ══════'));
  line(`  草稿 ${codes.length} 个　${TEXT_ONLY ? '只查文字' : IMAGES_ONLY ? '只查图片' : '文字 + 图片'}`);
  line('');
}

/**
 * 图片引擎的**覆盖率**必须打出来。
 *
 * 引擎按平台选：macOS → Vision，Linux → tesseract（见 scripts/lib/ocr.mjs）。
 * 两者能力不等价 —— ②图像分类只有 Vision 有。如果不说，Linux 上跑出来的
 * 「无疑似」会被误读成「图片干净」，而实际是**少查了一项**。
 */
let cap: Awaited<ReturnType<typeof capabilities>> | null = null;
if (!TEXT_ONLY) {
  cap = await capabilities();
  if (!AS_JSON) {
    if (!cap.ocr) {
      line(yellow(`  ⚠️ 图片引擎「${cap.engine}」不可用，图片检查将跳过 —— ${cap.note}`));
    } else {
      line(
        dim(
          `  图片引擎 ${cap.engine}　①OCR读字 ${cap.ocr ? '✔' : '✘'}　` +
            `②图像分类 ${cap.labels ? '✔' : '✘'}　③肤色占比 ${cap.skin ? '✔' : '✘'}`,
        ),
      );
      if (cap.note) line(yellow(`  ⚠️ ${cap.note}`));
      if (!cap.labels) {
        line(yellow('  ⚠️ ②图像分类在本引擎下不可用（仅 macOS Vision 有）——「过度暴露」只剩 ③肤色占比 一条线索'));
      }
    }
  }
}

/* ---------------- 执行 ---------------- */
const findings = [];
/** 全部结果（含通过的）—— 要落盘，后台才能直接看到「哪些体检过了」 */
const allResults = [];
let imgTotal = 0;

for (const [i, code] of codes.entries()) {
  const r = await checkDraft(code, {
    text: !IMAGES_ONLY,
    images: !TEXT_ONLY,
    cardText: TEXT_ONLY || IMAGES_ONLY ? '' : cardTextOf(code),
  });
  imgTotal += r.images;
  allResults.push(r);
  if (r.block.length || r.warn.length) findings.push(r);
  if (!AS_JSON && ((i + 1) % 25 === 0 || i === codes.length - 1)) {
    line(dim(`  …已查 ${i + 1}/${codes.length}　图片 ${imgTotal} 张`));
  }
}

// 结论落盘（按维度分桶）—— 后台「上架体检」页与发布闸门都读它。
// ⚠️ 只写本次查过的维度：跑「只查文字」不会清掉已有的图片结论。
saveResults(allResults, { text: !IMAGES_ONLY, images: !TEXT_ONLY });

/* ---------------- 报告 ---------------- */
const withBlock = findings.filter((f) => f.block.length);
const warnOnly = findings.filter((f) => !f.block.length && f.warn.length);

if (AS_JSON) {
  line(
    JSON.stringify(
      {
        checked: codes.length,
        images: imgTotal,
        // 覆盖率随结果一起出去：消费方（流水线 / 后台）才知道这次到底查了哪几项
        engine: cap?.engine ?? null,
        coverage: cap ? { ocr: cap.ocr, labels: cap.labels, skin: cap.skin } : null,
        coverage_note: cap?.note || null,
        blockers: withBlock,
        warns: warnOnly,
      },
      null,
      2,
    ),
  );
} else {
  line('');
  if (withBlock.length) {
    line(red(b(`⛔ 硬拦截 ${withBlock.length} 个 —— 这些**不要上架**`)));
    for (const f of withBlock) {
      line(`   ${b(f.code)}　${String(f.title || '').slice(0, 40)}`);
      for (const x of f.block) line(`     ${red('✗')} ${x}`);
      for (const x of f.warn) line(`     ${dim('·')} ${dim(x)}`);
    }
    line('');
  }
  if (warnOnly.length) {
    line(yellow(b(`⚠️  疑似 ${warnOnly.length} 个 —— 建议人工确认`)));
    for (const f of warnOnly.slice(0, 25)) {
      line(`   ${f.code}　${String(f.title || '').slice(0, 40)}`);
      for (const x of f.warn) line(`     ${dim('·')} ${x}`);
    }
    if (warnOnly.length > 25) line(dim(`   …其余 ${warnOnly.length - 25} 个`));
    line('');
  }
  const pass = codes.length - withBlock.length - warnOnly.length;
  line(
    `${b('汇总')}：检查 ${codes.length} 个　${red(`硬拦截 ${withBlock.length}`)}　` +
      `${yellow(`疑似 ${warnOnly.length}`)}　${green(`通过 ${pass}`)}`,
  );
  line(
    dim(
      `  图片共 ${imgTotal} 张　引擎 ${cap?.engine ?? '—'}　` +
        `词表 assets/_shared/banned-words.json　缓存 out/.preflight/`,
    ),
  );
  line('');
}

process.exit(withBlock.length ? 1 : 0);
