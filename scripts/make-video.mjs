#!/usr/bin/env node
/**
 * 竖版视频装配器：卡片 PNG → MP4（1080×1920 / 30fps / H.264）
 *
 * 做法分两步，方便定位问题：
 *   ① 每张卡单独出一段静音片：缓慢推拉（zoompan，进出交替）
 *   ② 段与段之间交叉溶解（xfade），拼成一条完整视频
 *
 * 为什么不带背景音乐：视频号/小红书都自带音乐库，用平台音乐①不吃版权②能进"用同款音乐"的流量池。
 * 所以这里刻意导出静音，音乐在发布时挂。
 *
 * 用法：
 *   node scripts/make-video.mjs --spec assets/video-specs/maccy.json
 *   node scripts/make-video.mjs --spec <spec.json> --cards <卡片目录> --out <输出mp4>
 *
 * 选项：--fps 30  --crf 20  --keep-segments（保留中间段，便于排查）
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── ffmpeg 定位（优先隔离目录里的静态包，不污染系统）─────────────────
function resolveFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const candidates = [
    path.join(process.env.HOME || '', '.workbuddy/binaries/node/workspace/node_modules/ffmpeg-static/ffmpeg'),
    path.join(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'ffmpeg'; // 退回 PATH
}

const FFMPEG = resolveFfmpeg();

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

function run(args, label) {
  process.stdout.write(`  · ${label}\n`);
  try {
    return execFileSync(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (e) {
    console.error(`\n❌ ${label} 失败`);
    console.error((e.stderr || e.message || '').toString().split('\n').slice(-25).join('\n'));
    process.exit(1);
  }
}

/** 用 ffmpeg -i 的输出解析媒体信息（本机没有独立的 ffprobe）
 *  ⚠️ 别用一个长正则去卡整行：pix_fmt 会长成 `yuv420p(tv, progressive)`，
 *     里面的逗号会把 `[^,]+` 截断 —— 逐项独立匹配才稳。
 */
function probe(file) {
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (e) {
    const txt = (e.stderr || '').toString();
    const vline = txt.split('\n').find((l) => l.includes('Video:')) || '';
    const dur = txt.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    const res = vline.match(/(\d{2,5})x(\d{2,5})/);
    const fps = vline.match(/([\d.]+)\s*fps/);
    const codec = vline.match(/Video:\s*([a-zA-Z0-9_]+)/);
    const pix = vline.match(/\b(yuv\d+\w*)\b/);
    return {
      duration: dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]) : null,
      codec: codec ? codec[1] : null,
      pixFmt: pix ? pix[1] : null,
      width: res ? +res[1] : null,
      height: res ? +res[2] : null,
      fps: fps ? parseFloat(fps[1]) : null,
    };
  }
  return null;
}

// ── 主流程 ──────────────────────────────────────────────────────────
const specPath = arg('spec');
if (!specPath) {
  console.error('用法：node scripts/make-video.mjs --spec <spec.json> [--cards <dir>] [--out <mp4>]');
  process.exit(2);
}

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const id = spec.id || path.basename(specPath, '.json');
const cardsDir = arg('cards', path.join('out', `video-${id}`, 'cards'));
const outMp4 = arg('out', path.join('out', `video-${id}`, `${id}-竖版.mp4`));
const segDir = path.join(path.dirname(outMp4), 'segments');

const FPS = Number(arg('fps', 30));
const CRF = arg('crf', '20');
const W = 1080;
const H = 1920;
const XFADE = 0.6; // 交叉溶解时长（秒）

const cards = spec.cards;
if (!cards?.length) {
  console.error('❌ spec 里没有 cards');
  process.exit(2);
}

console.log(`\n🎬 装配 ${spec.appName || id} 竖版视频`);
console.log(`   ffmpeg : ${FFMPEG}`);
console.log(`   卡片   : ${cardsDir}（${cards.length} 张）`);
console.log(`   规格   : ${W}×${H} / ${FPS}fps / 交叉溶解 ${XFADE}s\n`);

fs.mkdirSync(segDir, { recursive: true });

// ── ① 每张卡出一段 ─────────────────────────────────────────────────
const segs = [];
cards.forEach((c, i) => {
  const png = path.join(cardsDir, `card-${String(i + 1).padStart(2, '0')}.png`);
  if (!fs.existsSync(png)) {
    console.error(`❌ 缺卡片：${png}\n   先跑：python3 scripts/render-video-cards.py ${specPath} ${cardsDir}`);
    process.exit(1);
  }
  const dur = Number(c.dur || 5);
  const frames = Math.round(dur * FPS);
  const seg = path.join(segDir, `seg-${String(i + 1).padStart(2, '0')}.mp4`);

  // 先放大到 1.33×，推拉时始终是"缩小"到输出尺寸 → 不会因为裁切而糊
  const zoomIn = c.zoom !== 'out';
  const step = 0.0009;
  const z = zoomIn
    ? `min(1+${step}*on,1.16)`
    : `max(1.16-${step}*on,1)`;
  const vf = [
    `scale=${Math.round(W * 4 / 3)}:${Math.round(H * 4 / 3)}`,
    `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`,
    'format=yuv420p',
  ].join(',');

  run(
    ['-y', '-i', png, '-vf', vf, '-frames:v', String(frames),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', seg],
    `卡 ${i + 1}/${cards.length} · ${c.type} · ${dur}s · 推${zoomIn ? '近' : '远'}`,
  );
  segs.push(seg);
});

// ── ② 交叉溶解拼接 ─────────────────────────────────────────────────
const parts = [];
segs.forEach((_, i) => parts.push(`[${i}:v]fps=${FPS},format=yuv420p,settb=AVTB[v${i}]`));

// offset_i = 前 i+1 段累计时长 − (i+1)×交叉溶解时长
let cum = 0;
let prev = 'v0';
const chain = [];
for (let i = 0; i < segs.length - 1; i++) {
  cum += Number(cards[i].dur || 5);
  const offset = cum - (i + 1) * XFADE;
  const out = i === segs.length - 2 ? 'vout' : `x${i}`;
  chain.push(`[${prev}][v${i + 1}]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}[${out}]`);
  prev = out;
}

const filter = [...parts, ...chain].join(';');
const args = ['-y'];
segs.forEach((s) => args.push('-i', s));
args.push(
  '-filter_complex', filter,
  '-map', '[vout]',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', CRF,
  '-pix_fmt', 'yuv420p', '-r', String(FPS),
  '-movflags', '+faststart',
  outMp4,
);
run(args, `交叉溶解拼接（${segs.length} 段 → 1 条）`);

// ── ③ 核验 ──────────────────────────────────────────────────────────
const info = probe(outMp4);
const sizeMb = (fs.statSync(outMp4).size / 1024 / 1024).toFixed(2);
const expect = cards.reduce((a, c) => a + Number(c.dur || 5), 0) - (segs.length - 1) * XFADE;

console.log('\n✅ 完成');
console.log(`   文件   : ${outMp4}`);
console.log(`   体积   : ${sizeMb} MB`);
console.log(`   规格   : ${info?.width}×${info?.height} / ${info?.fps}fps / ${info?.codec} / ${info?.pixFmt}`);
console.log(`   时长   : ${info?.duration?.toFixed(2)}s（预期 ${expect.toFixed(2)}s）`);

const problems = [];
if (info?.width !== W || info?.height !== H) problems.push(`分辨率不符（${info?.width}×${info?.height}）`);
if (info?.pixFmt !== 'yuv420p') problems.push(`像素格式不符（${info?.pixFmt}）`);
if (info?.duration && Math.abs(info.duration - expect) > 0.6) problems.push(`时长偏差 ${(info.duration - expect).toFixed(2)}s`);
if (Number(sizeMb) > 80) problems.push(`体积偏大 ${sizeMb}MB`);

if (problems.length) {
  console.log('\n⚠️ 需要留意：');
  problems.forEach((p) => console.log('   -', p));
} else {
  console.log('\n   验收：规格 / 时长 / 体积均正常 ✅');
}

if (!hasFlag('keep-segments')) {
  fs.rmSync(segDir, { recursive: true, force: true });
  console.log('   （中间段已清理，需要保留加 --keep-segments）');
}
console.log('');
