/**
 * 上架前体检的**核心实现**（纯 JS，供 .mjs / .ts 脚本共用）。
 *
 * 抽成 lib 的原因：`scripts/preflight.ts`（命令行）和 `scripts/republish-stuck.ts`（批量发布）
 * 都要用它 —— 发布脚本必须在**提交上架前**拦住违规品。规则只能有一份，
 * 否则「命令行查得出来、发布时却没拦住」这种漂移迟早出事。
 *
 * ── 三道检查
 *   1. 文字：标题 / 商品说明 / 发货内容 → 违禁词表（block 硬拦截、warn 疑似）
 *   2. 图片 OCR：读图里的字 → 查 GPT / ChatGPT 这类 token（**这条是 block**）
 *      ⚠️ 2026-10-08 事故：一个 Blender 插件的**封面图带「GPT」字样** → 账号被封控。
 *         纯文本扫描挡不住，**必须 OCR**。
 *   3. 图片内容：图像分类标签 + **肤色像素占比**兜底（过度暴露的女性图片，均为 warn）
 *
 * 图片引擎不写死：macOS 走 Vision，Linux 走 tesseract，见 `./ocr.mjs`。
 * 图片结果按「URL 哈希 + 引擎」缓存在 `out/.preflight/`，重复跑不重算。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readImage, ensureEngine, engineName, capabilities as engineCapabilities } from './ocr.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DRAFTS = path.join(ROOT, 'drafts');
const CACHE = path.join(ROOT, 'out', '.preflight');
const IMG_CACHE = path.join(CACHE, 'img');
const SCAN_CACHE = path.join(CACHE, 'scan');
for (const d of [CACHE, IMG_CACHE, SCAN_CACHE]) fs.mkdirSync(d, { recursive: true });

export const RULES = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'assets', '_shared', 'banned-words.json'), 'utf8'),
);

const toRe = (p) => new RegExp(p, 'gi');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

/**
 * OCR 归一化：去空格标点后比对，并还原常见「数字被认成字母」的混淆。
 * ⚠️ 实测 OCR 会把 `GPT-4` 读成 `GP1-4`，只按原文精确匹配会漏。
 */
export const normText = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const normLoose = (s) => normText(s).replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B');

/**
 * 扫一段文字。
 * ⚠️ 必须先剥掉 URL —— 实测 `https://pan.b**ai**du.com` 会被「AI」规则命中，
 *    这类噪声会把真正的问题淹掉。
 */
export function scanText(raw, where) {
  const hits = { block: [], warn: [] };
  if (!raw) return hits;
  const text = String(raw).replace(/https?:\/\/\S+/g, ' ');
  for (const [level, list] of [['block', RULES.text.block], ['warn', RULES.text.warn]]) {
    for (const rule of list) {
      const re = toRe(rule.pattern);
      let m;
      let n = 0;
      const samples = new Set();
      while ((m = re.exec(text)) !== null && n < 5) {
        n++;
        const s = Math.max(0, m.index - 18);
        samples.add(text.slice(s, m.index + m[0].length + 18).replace(/\s+/g, ' '));
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      if (n) {
        hits[level].push({
          pattern: rule.pattern,
          why: rule.why,
          where,
          count: n,
          samples: [...samples].slice(0, 3),
        });
      }
    }
  }
  return hits;
}

/* ---------------- 图片 ---------------- */

/** 兼容旧调用点（scripts/preflight.ts、publish-guard.ts 都按这个名字调） */
export const ensureVision = ensureEngine;

/** 这个引擎实际覆盖了哪些图片能力 —— 必须打给操作者看，不能静默 */
export const capabilities = engineCapabilities;

/** 缓存目录按引擎分桶，理由见 scanImage() 的注释 */
function scanCacheDir() {
  return path.join(SCAN_CACHE, engineName());
}

async function fetchImage(url) {
  const h = sha1(url);
  const ext = (url.match(/\.(png|jpe?g|webp|gif)(\?|$)/i) || [, 'png'])[1].toLowerCase();
  const file = path.join(IMG_CACHE, `${h}.${ext}`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30_000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    return file;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 扫一张图（结果按「URL 哈希 + 引擎」缓存）。
 *
 * ⚠️ 缓存必须按引擎分目录。原来只按 URL 哈希存，一旦换引擎就会**命中另一个引擎的旧结果**
 *    —— 在 Linux 上永远拿不到 tesseract 的答案，却显示「已体检」。这正是静默漂移。
 */
export async function scanImage(url) {
  const dir = scanCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const h = sha1(url);
  const cacheFile = path.join(dir, `${h}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      /* 缓存坏了就重算 */
    }
  }
  const local = await fetchImage(url);
  const res = await readImage(local);
  res.url = url;
  res.local = local;
  res.engine = engineName();
  fs.writeFileSync(cacheFile, JSON.stringify(res));
  return res;
}

/** 对一张已扫描的图做违禁判定 */
export function judgeImage(scan) {
  const out = { block: [], warn: [] };
  if (scan.error) {
    out.warn.push(`图片读取失败：${scan.error}`);
    return out;
  }
  // ① OCR 违禁 token
  const joined = normText((scan.texts || []).join(' '));
  const joinedLoose = normLoose((scan.texts || []).join(' '));
  for (const tok of RULES.image.ocr_tokens) {
    const t = normText(tok);
    const tl = normLoose(tok);
    if (joined.includes(t) || (tl.length >= 4 && joinedLoose.includes(tl))) {
      out.block.push(`图内文字命中「${tok}」（OCR 读到：${(scan.texts || []).join(' / ').slice(0, 90)}）`);
    }
  }
  // ② 分类标签
  for (const l of scan.labels || []) {
    const id = String(l.id).toLowerCase();
    if (RULES.image.risky_labels.some((r) => id === r || id.includes(r))) {
      if (l.c >= RULES.image.labelConfidenceWarn) {
        out.warn.push(`图像识别为「${l.id}」(置信度 ${(l.c * 100).toFixed(0)}%)，请人工确认是否过度暴露`);
      }
    }
  }
  // ③ 肤色占比兜底
  if (scan.skinRatio >= RULES.image.skinRatioWarn && scan.skinCenter >= RULES.image.skinCenterWarn) {
    out.warn.push(
      `肤色像素占比偏高（整体 ${(scan.skinRatio * 100).toFixed(0)}% / 中心区 ${(scan.skinCenter * 100).toFixed(0)}%），请人工确认`,
    );
  }
  return out;
}

/* ---------------- 对外主入口 ---------------- */

/**
 * 体检一个草稿。
 * @param {string} code 草稿编码（BD-xxx）
 * @param {{ text?: boolean, images?: boolean, cardText?: string }} opts
 * @returns {Promise<{ code, title, block: string[], warn: string[], images: number }>}
 */
export async function checkDraft(code, opts = {}) {
  const { text = true, images = true, cardText = '' } = opts;
  const file = path.join(DRAFTS, `${code}.json`);
  const block = [];
  const warn = [];
  let imgCount = 0;
  if (!fs.existsSync(file)) return { code, title: '', block, warn, images: 0 };

  let draft;
  try {
    draft = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { code, title: '(草稿损坏)', block, warn, images: 0 };
  }
  const shop = (draft.publish_shop || [])[0] || {};

  if (text) {
    for (const [field, val] of [
      ['标题', shop.title],
      ['商品说明', shop.content],
    ]) {
      const h = scanText(val, field);
      for (const x of h.block) block.push(`【${x.where}】命中「${x.pattern}」 —— ${x.why}\n       例：…${x.samples[0] ?? ''}…`);
      for (const x of h.warn) warn.push(`【${x.where}】疑似「${x.pattern}」 —— ${x.why}\n       例：…${x.samples[0] ?? ''}…`);
    }
    if (cardText) {
      const h = scanText(cardText, '发货内容');
      for (const x of h.block) block.push(`【${x.where}】命中「${x.pattern}」 —— ${x.why}\n       例：…${x.samples[0] ?? ''}…`);
      for (const x of h.warn) warn.push(`【${x.where}】疑似「${x.pattern}」 —— ${x.why}\n       例：…${x.samples[0] ?? ''}…`);
    }
  }

  if (images) {
    for (const url of [...new Set(shop.images || [])]) {
      imgCount++;
      let scan;
      try {
        scan = await scanImage(url);
      } catch (e) {
        warn.push(`图片扫描失败：${url}（${String(e?.message ?? e).slice(0, 60)}）`);
        continue;
      }
      const j = judgeImage(scan);
      for (const s of j.block) block.push(`【图片】${url}\n       ${s}`);
      for (const s of j.warn) warn.push(`【图片】${url}\n       ${s}`);
    }
  }

  return { code, title: shop.title || '', block, warn, images: imgCount };
}

/** 读卡密池里的发货内容（没有卡密池也能跑） */
export function cardTextOf(code) {
  try {
    const cards = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'xgj-gateway', 'data', 'cards.json'), 'utf8'));
    const c = cards[code];
    return Array.isArray(c) ? c.map((x) => x.card_pwd || '').join(' ') : '';
  } catch {
    return '';
  }
}

/** 列出全部草稿编码 */
export function allCodes() {
  return fs
    .readdirSync(DRAFTS)
    .filter((f) => /^BD-.*\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ''));
}

export function loadListings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DRAFTS, '.listings.json'), 'utf8'));
  } catch {
    return {};
  }
}

/* ==========================================================================
   体检结论缓存
   ⚠️⚠️ 必须按「文字 / 图片」**分桶**存，读取时再合并。
   否则会出现：先跑「只查文字」拿到 9 个违规，再跑「只查图」—— 后者把前者的
   结论整个覆盖掉，9 个违规凭空消失。这种「结论互相覆盖」的静默漂移正是
   我们最怕的：体检看起来跑过了，其实结论是缺的。
   ========================================================================== */

const RESULT_FILE = path.join(ROOT, 'out', 'preflight-results.json');

/** 原始分桶结构：{ [code]: { code, title, text?, image? } } */
function loadRaw() {
  try {
    const d = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

/**
 * 读取合并后的结论。
 * @returns {Record<string, {code,title,block,warn,images,with_images,at}>}
 */
export function loadResults() {
  const raw = loadRaw();
  const out = {};
  for (const [code, r] of Object.entries(raw)) {
    if (!r) continue;
    const t = r.text;
    const im = r.image;
    if (!t && !im) continue;
    out[code] = {
      code,
      title: r.title || t?.title || im?.title || '',
      block: [...(t?.block || []), ...(im?.block || [])],
      warn: [...(t?.warn || []), ...(im?.warn || [])],
      images: im?.images ?? 0,
      with_images: !!im,
      has_text: !!t,
      at: (im?.at && t?.at ? (im.at > t.at ? im.at : t.at) : im?.at || t?.at) || null,
    };
  }
  return out;
}

/**
 * 写入体检结论（只覆盖本次实际检查过的维度）。
 * @param {Array} results checkDraft 的返回
 * @param {{text?: boolean, images?: boolean}} dims 这次跑了哪些维度
 */
export function saveResults(results, dims = { text: true, images: false }) {
  const raw = loadRaw();
  const at = new Date().toISOString();
  for (const r of results || []) {
    if (!r?.code) continue;
    const cur = raw[r.code] || { code: r.code };
    cur.title = r.title || cur.title || '';
    if (dims.text) cur.text = { at, title: r.title || '', block: r.block || [], warn: r.warn || [] };
    if (dims.images) {
      cur.image = {
        at,
        title: r.title || '',
        // ⚠️ 图片维度的 block/warn 只取图片相关条目（前缀「【图片】」），
        //    否则会把同一批结果里的文字条目也算进图片桶，合并后重复计数。
        block: (r.block || []).filter((x) => String(x).startsWith('【图片】')),
        warn: (r.warn || []).filter((x) => String(x).startsWith('【图片】')),
        images: r.images ?? 0,
      };
    }
    raw[r.code] = cur;
  }
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  const tmp = `${RESULT_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, RESULT_FILE);
}
