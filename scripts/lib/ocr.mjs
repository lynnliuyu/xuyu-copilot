/**
 * 图片体检引擎 —— 把「跟平台绑定」的那部分从 preflight.mjs 里摘出来。
 *
 * ── 为什么要抽这一层
 * 体检的图片部分原本直接调 macOS Vision（用 swiftc 现编 scripts/vision-scan.swift）。
 * 但整套服务要能装进容器、搬到 Linux 机器上跑，而 Vision 只在 macOS 存在。
 * 所以按平台选引擎：
 *   darwin → vision     （编译 vision-scan.swift；本层引入前是什么行为，现在还是什么行为）
 *   linux  → tesseract  （镜像里 apt 装 tesseract-ocr + chi_sim + eng）
 * 显式覆盖：PREFLIGHT_OCR=vision|tesseract|off
 *
 * ── 三个能力，可移植性不同（改动前必须先看这张表）
 *   ① OCR 读图里的字 → 查违禁 token        vision ✅  tesseract ✅
 *   ② 图像分类（~1300 类）→ 暴露类提示      vision ✅  tesseract ❌ 无轻量替代
 *   ③ 肤色像素占比 → 暴露类提示（兜底）      vision ✅  tesseract ✅ 用 JS 解码补回
 *
 * ⚠️ ② 和 ③ 都只产生 **warn**（让人去确认），只有 ① 产生 **block**（直接拦上架）。
 *    所以换引擎时真正不能丢的是 ① —— 那恰好是能换的那个。
 *    ② 在 Linux 上会永久缺失；capabilities() 会把它报出来，调用方**必须**把覆盖率
 *    打给操作者看，不能静默（铁律 #2 那次事故的教训就是「以为查过、其实没查」）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VISION_SRC = path.join(ROOT, 'scripts', 'vision-scan.swift');
const VISION_BIN = path.join(ROOT, 'out', 'bin', 'vision-scan');

/** 引擎选择：显式 env 优先，否则按平台 */
export function engineName() {
  const forced = String(process.env.PREFLIGHT_OCR || '').trim().toLowerCase();
  if (forced === 'vision' || forced === 'tesseract' || forced === 'off') return forced;
  return process.platform === 'darwin' ? 'vision' : 'tesseract';
}

const state = { engine: null, ready: false, note: '' };
let _jimp;

/** 懒加载 jimp（纯 JS，无原生二进制 —— 这是它能跟着容器走的原因） */
async function jimp() {
  if (_jimp !== undefined) return _jimp;
  try {
    const m = await import('jimp');
    _jimp = m.default ?? m;
  } catch {
    _jimp = null;
  }
  return _jimp;
}

/**
 * 确保引擎可用。
 * ⚠️ 这里必须**真的探测**，不能只看文件在不在 —— 原实现只判断 VISION_BIN 是否存在，
 *    在 Linux 容器里挂上 out/ 会误判为「可用」（那个二进制是 Mach-O，根本 exec 不了）。
 */
export async function ensureEngine() {
  const want = engineName();
  if (state.engine === want && state.ready) return true;
  state.engine = want;
  state.ready = false;
  state.note = '';

  if (want === 'off') {
    state.note = 'PREFLIGHT_OCR=off：图片体检已显式关闭';
    return false;
  }

  if (want === 'vision') {
    if (process.platform !== 'darwin') {
      state.note = `vision 引擎需要 macOS（当前 platform=${process.platform}）`;
      return false;
    }
    // 产物存在也要验一下是不是本机架构的原生可执行文件
    if (fs.existsSync(VISION_BIN)) {
      try {
        await execFileP(VISION_BIN, [], { timeout: 10_000 });
      } catch (e) {
        // 无参数时它自己会 exit(2) 并打印用法 —— 那是**正常**的
        if (e?.code !== 2) {
          state.note = `vision 二进制不可执行：${String(e?.message ?? e).slice(0, 120)}`;
          return false;
        }
      }
      state.ready = true;
      return true;
    }
    if (!fs.existsSync(VISION_SRC)) {
      state.note = `找不到 ${VISION_SRC}`;
      return false;
    }
    fs.mkdirSync(path.dirname(VISION_BIN), { recursive: true });
    try {
      await execFileP(
        'swiftc',
        ['-O', '-o', VISION_BIN, VISION_SRC, '-framework', 'Vision', '-framework', 'AppKit', '-framework', 'CoreGraphics'],
        { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
      );
    } catch (e) {
      state.note = `swiftc 编译失败：${String(e?.message ?? e).slice(0, 120)}`;
      return false;
    }
    state.ready = fs.existsSync(VISION_BIN);
    if (!state.ready) state.note = 'swiftc 未产出编译结果';
    return state.ready;
  }

  // tesseract
  try {
    const { stdout } = await execFileP('tesseract', ['--list-langs'], { timeout: 15_000 });
    const langs = stdout.split('\n').map((s) => s.trim());
    const missing = ['eng', 'chi_sim'].filter((l) => !langs.includes(l));
    state.ready = true;
    if (missing.length) state.note = `tesseract 缺少语言包：${missing.join(', ')}`;
    return true;
  } catch (e) {
    state.note = '未找到 tesseract（Linux 容器内需装 tesseract-ocr + 中文/英文语言包）';
    return false;
  }
}

/**
 * 报出这个引擎实际覆盖了哪些能力。
 * ⭐ 调用方应把 capabilities 打给操作者 —— 覆盖率变化必须是**可见的**。
 */
export async function capabilities() {
  const engine = engineName();
  const ready = await ensureEngine();
  const hasJimp = Boolean(await jimp());
  return {
    engine,
    ready,
    /** ① OCR → 硬拦截。两个引擎都有。 */
    ocr: ready && engine !== 'off',
    /** ② 图像分类（~1300 类）→ 仅 Vision 有 */
    labels: ready && engine === 'vision',
    /** ③ 肤色占比 → 靠 JS 解码补，两个引擎都能用 */
    skin: ready && engine !== 'off' && hasJimp,
    note: state.note,
  };
}

/** 与 vision-scan.swift 里 isSkin() 完全相同的判定（RGB + YCbCr 双条件） */
function isSkin(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const rgbOK = r > 95 && g > 40 && b > 20 && mx - mn > 15 && Math.abs(r - g) > 15 && r > g && r > b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const yccOK = cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
  return rgbOK && yccOK;
}

/**
 * 肤色占比：整体 + 中心区（中央 50% 见方）。
 * 参数与 Swift 版一字不差：采样宽 min(w,320)，采样高按比例，中心区取 1/4~3/4。
 * 只算比例，不关心上下翻转（中心区在两个方向上都是对称的）。
 */
async function skinStats(file) {
  const Jimp = await jimp();
  if (!Jimp) return {};
  try {
    const img = await Jimp.read(file);
    const w = img.bitmap.width;
    const h = img.bitmap.height;
    if (!w || !h) return {};
    const sampleW = Math.min(w, 320);
    const sampleH = Math.max(1, Math.round((h * sampleW) / w));
    if (sampleW !== w || sampleH !== h) img.resize(sampleW, sampleH);

    const { data } = img.bitmap;
    const cx0 = Math.floor(sampleW / 4);
    const cx1 = Math.floor((sampleW * 3) / 4);
    const cy0 = Math.floor(sampleH / 4);
    const cy1 = Math.floor((sampleH * 3) / 4);
    let total = 0;
    let skin = 0;
    let cTotal = 0;
    let cSkin = 0;
    for (let y = 0; y < sampleH; y++) {
      for (let x = 0; x < sampleW; x++) {
        const i = (y * sampleW + x) * 4;
        const s = isSkin(data[i], data[i + 1], data[i + 2]);
        total++;
        if (s) skin++;
        if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) {
          cTotal++;
          if (s) cSkin++;
        }
      }
    }
    return {
      width: w,
      height: h,
      skinRatio: total ? skin / total : 0,
      skinCenter: cTotal ? cSkin / cTotal : 0,
    };
  } catch {
    return {};
  }
}

const EMPTY = { texts: [], labels: [], skinRatio: 0, skinCenter: 0, width: 0, height: 0, error: null };

/**
 * 读一张本地图片，返回与 vision-scan.swift 同形的结构：
 *   { texts, labels, skinRatio, skinCenter, width, height, error }
 * 调用方（preflight.mjs）负责 URL 抓取与缓存，这里只管「把一张图看明白」。
 */
export async function readImage(file) {
  const res = { ...EMPTY };
  const engine = engineName();

  if (engine === 'off') {
    res.error = 'PREFLIGHT_OCR=off：未做图片体检';
    return res;
  }

  if (engine === 'vision') {
    try {
      const { stdout } = await execFileP(VISION_BIN, [file], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
      const line = stdout.trim().split('\n').pop();
      if (!line) {
        res.error = 'Vision 无输出';
        return res;
      }
      return { ...res, ...JSON.parse(line) };
    } catch (e) {
      res.error = `Vision 执行失败：${String(e?.message ?? e).slice(0, 120)}`;
      return res;
    }
  }

  // tesseract
  try {
    const psm = String(process.env.TESSERACT_PSM || '3');
    const { stdout } = await execFileP(
      'tesseract',
      [file, 'stdout', '-l', 'chi_sim+eng', '--psm', psm],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
    );
    res.texts = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    res.error = `tesseract 执行失败：${String(e?.message ?? e).slice(0, 120)}`;
    return res;
  }

  // ② 图像分类在本引擎下没有替代实现 —— labels 保持空（capabilities() 已把这点报出去）
  Object.assign(res, await skinStats(file));
  return res;
}
