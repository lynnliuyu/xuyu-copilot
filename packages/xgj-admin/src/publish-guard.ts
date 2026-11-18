/**
 * 发布闸门 —— 所有「提交上架」都必须先过这一关。
 *
 * ⚠️⚠️ 为什么必须放在**服务端**而不是前端按钮上：
 *   2026-10-08 两起事故的根因都在「后端没护栏」：
 *   ① 后台「按顺序发布全部」的间隔写死 **900 毫秒**（比约定快 333 倍）
 *      → 16:01 闲鱼一次性批量下架约 405 个在售商品，在售从 450 掉到 152。
 *   ② `publish.run` 完全没有体检 → 一个封面图带「GPT」字样的 Blender 插件
 *      直接上架，导致**账号被封控**。
 *   前端按钮是可以被换掉、被绕过、被脚本直接打接口的 —— 所以护栏只能在后端。
 *   CLI（`npm run republish`）也已接同一套规则，**规则只有一份**：
 *   `scripts/lib/preflight.mjs`。
 *
 * ── 两道闸门
 *   1. **体检**：文字（标题/说明/发货内容）+ 图片 OCR + 图像内容识别，违规直接拒绝
 *   2. **节流**：两次提交之间至少间隔 `XGJ_PUBLISH_MIN_INTERVAL` 秒（默认 300）
 *      节流状态持久化到 `out/publish-guard.json`，进程重启也不丢。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = path.join(ROOT, 'out');
const STATE_FILE = path.join(OUT, 'publish-guard.json');

/* ---------------------------------------------------------------- 节流配置 */

/**
 * 两次提交上架之间的**最小**间隔（秒）。
 * ⚠️ 默认 300 秒（5 分钟）不是拍脑袋 —— 项目里 `drip-publish.mjs` 早就记录了
 *   「闲鱼对短时间集中上架有风控，一次发几十个容易触发限流」，用户也明确要求 5 分钟一个。
 *   调小它等于主动去撞风控，务必先想清楚。
 */
export const MIN_INTERVAL_SEC = Math.max(0, Number(process.env.XGJ_PUBLISH_MIN_INTERVAL ?? 300) || 0);
const MIN_INTERVAL_MS = MIN_INTERVAL_SEC * 1000;

/** 单次批量发布允许的条数上限（超过要求用户显式确认）。防止「一键发 300 个」。 */
export const BATCH_WARN_SIZE = Math.max(1, Number(process.env.XGJ_PUBLISH_BATCH_WARN ?? 20) || 20);

interface GuardState {
  /** 上一次**提交上架**的时刻（ISO）。注意是提交时刻，不是上架成功时刻。 */
  last_publish_at: string | null;
  /** 最近若干次提交记录，便于事后追查「谁在什么时候发了多少」 */
  history: { at: string; code: string; forced?: boolean; bypassed?: boolean }[];
}

function loadState(): GuardState {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { last_publish_at: s.last_publish_at ?? null, history: Array.isArray(s.history) ? s.history : [] };
  } catch {
    return { last_publish_at: null, history: [] };
  }
}

function saveState(s: GuardState) {
  fs.mkdirSync(OUT, { recursive: true });
  // 只留最近 200 条，避免无限增长
  s.history = s.history.slice(-200);
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

export interface GuardStatus {
  min_interval_sec: number;
  last_publish_at: string | null;
  /** 还要等多少毫秒才能再次提交；0 = 现在就可以 */
  wait_ms: number;
  /** 可再次提交的时刻（等待中才有值） */
  next_at: string | null;
  /** 今天已提交的次数 */
  today_count: number;
}

/* ------------------------------------------------------ 永久排除名单 */

/**
 * 「永久排除」的草稿 —— 内容违规 / 法定违禁品 / 侵权，**不再发布**。
 *
 * 为什么不直接删草稿：① 删掉就失去了「为什么排除」的记录，以后可能又被重新生成；
 * ② 保留草稿才能核对当时体检命中的原文。
 * 存 `drafts/.excluded.json`：（与 `.listings.json` 同为运行时状态，不入库）
 */
const EXCLUDE_FILE = path.join(ROOT, 'drafts', '.excluded.json');

export interface Exclusion {
  reason: string;
  at: string;
  /** 排除时的主要命中项（便于回看） */
  hits?: string[];
}

export function loadExclusions(): Record<string, Exclusion> {
  try {
    const d = JSON.parse(fs.readFileSync(EXCLUDE_FILE, 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

function saveExclusions(d: Record<string, Exclusion>) {
  const tmp = `${EXCLUDE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, EXCLUDE_FILE);
}

export function exclude(code: string, reason: string, hits?: string[]): Exclusion {
  const d = loadExclusions();
  const rec: Exclusion = { reason, at: new Date().toISOString(), hits };
  d[code] = rec;
  saveExclusions(d);
  return rec;
}

export function unexclude(code: string) {
  const d = loadExclusions();
  delete d[code];
  saveExclusions(d);
}

export function guardStatus(now = Date.now()): GuardStatus {
  const st = loadState();
  const last = st.last_publish_at ? Date.parse(st.last_publish_at) : 0;
  const remain = last ? Math.max(0, MIN_INTERVAL_MS - (now - last)) : 0;
  const today = new Date(now).toISOString().slice(0, 10);
  return {
    min_interval_sec: MIN_INTERVAL_SEC,
    last_publish_at: st.last_publish_at,
    wait_ms: remain,
    next_at: remain ? new Date(now + remain).toISOString() : null,
    today_count: st.history.filter((h) => String(h.at).slice(0, 10) === today).length,
  };
}

export class RateLimited extends Error {
  readonly waitMs: number;
  readonly nextAt: string;
  constructor(waitMs: number, nextAt: string, minIntervalSec: number) {
    super(`发布节流：每 ${minIntervalSec} 秒最多提交 1 个，还需等待 ${Math.ceil(waitMs / 1000)} 秒`);
    this.name = 'RateLimited';
    this.waitMs = waitMs;
    this.nextAt = nextAt;
  }
}

/**
 * 占一个发布名额。**必须在调用闲管家接口之前**调用 ——
 * 节流要限制的是「发给平台的请求频率」，跟成功与否无关。
 */
export function takeSlot(code: string, opts: { force?: boolean } = {}) {
  const st = guardStatus();
  if (st.wait_ms > 0 && !opts.force) {
    throw new RateLimited(st.wait_ms, st.next_at as string, MIN_INTERVAL_SEC);
  }
  const s = loadState();
  const at = new Date().toISOString();
  s.last_publish_at = at;
  s.history.push({ at, code, forced: opts.force || undefined });
  saveState(s);
}

/* ------------------------------------------------------------------ 体检 */

/** `scripts/lib/preflight.mjs` 的形状（纯 JS，不在 tsconfig include 里，故手写类型） */
interface CheckResult {
  code: string;
  title: string;
  block: string[];
  warn: string[];
  images: number;
}
export interface CachedResult {
  code: string;
  title: string;
  block: string[];
  warn: string[];
  images: number;
  with_images: boolean;
  has_text: boolean;
  at: string | null;
}
interface PreflightLib {
  checkDraft(code: string, opts?: { text?: boolean; images?: boolean; cardText?: string }): Promise<CheckResult>;
  allCodes(): string[];
  cardTextOf(code: string): string;
  ensureVision(): Promise<boolean>;
  /** 引擎覆盖率：macOS Vision 有图像分类，Linux tesseract 没有 —— 见 scripts/lib/ocr.mjs */
  capabilities(): Promise<{
    engine: string;
    ready: boolean;
    ocr: boolean;
    labels: boolean;
    skin: boolean;
    note: string;
  }>;
  normText(s: string): string;
  loadResults(): Record<string, CachedResult>;
  saveResults(rs: CheckResult[], dims: { text?: boolean; images?: boolean }): void;
  RULES: Record<string, any>;
}

let libPromise: Promise<PreflightLib> | null = null;
function lib(): Promise<PreflightLib> {
  if (!libPromise) {
    // ⚠️ 纯 JS 模块（scripts/lib/preflight.mjs），不在 tsconfig 的 include 里。
    //    故意共用同一份实现 —— 命令行、批量脚本、后台必须给出**完全一致**的结论。
    //    用非字面量说明符让 TS 不去解析它（解析不到会报 TS7016）。
    const url = new URL('../../../scripts/lib/preflight.mjs', import.meta.url).href;
    libPromise = import(url) as unknown as Promise<PreflightLib>;
  }
  return libPromise;
}

export interface PreflightOptions {
  text?: boolean;
  images?: boolean;
  /** 只查这些草稿；不传 = 全部队列（由调用方决定） */
  codes?: string[];
}

/** 体检一个草稿（含发货内容）。 */
export async function checkOne(code: string, opts: PreflightOptions = {}): Promise<CheckResult> {
  const l = await lib();
  if (opts.images) await l.ensureVision();
  return l.checkDraft(code, { text: opts.text !== false, images: !!opts.images, cardText: l.cardTextOf(code) });
}

/** 批量体检（顺序执行，图片扫描较重）。 */
export async function checkMany(codes: string[], opts: PreflightOptions = {}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const c of codes) out.push(await checkOne(c, opts));
  return out;
}

export async function listCodes(): Promise<string[]> {
  return (await lib()).allCodes();
}

/**
 * 当前图片引擎实际覆盖了哪些能力。
 *
 * ⭐ 后台体检结果里必须带上它。引擎按平台自动选（macOS → Vision，Linux → tesseract），
 *    两者能力**不等价**：tesseract 没有图像分类。如果结果里不说明，
 *    Linux 上跑出来的「无疑似」会被误读成「图片干净」，而真相是**少查了一项**。
 */
export async function preflightCapabilities() {
  try {
    return await (await lib()).capabilities();
  } catch {
    return null;
  }
}

/** 读合并后的体检结论（文字 + 图片）。格式与命令行共用，见 lib 顶部说明。 */
export function loadResults(): Record<string, CachedResult> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(OUT, 'preflight-results.json'), 'utf8'));
    return mergeRaw(raw);
  } catch {
    return {};
  }
}

/** 与 lib 内 `loadResults` 同逻辑的同步版（避免为了同步读而阻塞事件循环） */
function mergeRaw(raw: Record<string, any>): Record<string, CachedResult> {
  const out: Record<string, CachedResult> = {};
  for (const [code, r] of Object.entries(raw || {})) {
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
 * 写入体检结论。**按维度分桶**（文字/图片各存一份），读取时合并 ——
 * 否则「只查文字」的结论会被后来的「只查图」覆盖掉（反之亦然）。
 */
export async function saveResults(results: CheckResult[], dims: { text?: boolean; images?: boolean }) {
  const l = await lib();
  l.saveResults(results, dims);
}

/** 违禁词表（前端展示用） */
export async function bannedWords() {
  const l = await lib();
  return l.RULES;
}
