/**
 * 网盘目录扫描 —— 为资源条目生成「两侧文件夹清单」。
 *
 * 两侧走的是完全不同的通道，这里统一成同一个返回结构：
 *   · 百度：直接用 bdpan-core 的 list API（有 token 就能读全盘）
 *   · 夸克：调用官方 Skill 的 CLI（browse 子命令），解析它写出的 JSONL
 *
 * 夸克侧每次调用都要起一个子进程（约 2~3 秒），所以**按需下钻**而不是一次性递归：
 * 先列根目录拿 FID，再进下一层。资源目录通常只有 1~2 层，成本可接受。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { list } from '../../bdpan-core/src/files';

const exec = promisify(execFile);

const QUARK_CLI = path.join(os.homedir(), '.workbuddy', 'skills', 'quarkclouddrive', 'scripts', 'quark-drive.cjs');
/** 固定 session id：同一对话内复用，避免每次都被当成新会话 */
const QUARK_SESSION = 'xgj-admin';

export interface ScannedItem {
  name: string;
  isDir: boolean;
  size?: number;
  fid?: string;
}

export interface ScanResult {
  side: 'baidu' | 'quark';
  root: string;
  items: ScannedItem[];
  /** 仅目录名，用于命名一致性比对 */
  folders: string[];
  fileCount: number;
  dirCount: number;
  sizeBytes: number;
  /** 夸克侧解析出的目录 FID，便于后续下钻 */
  fid?: string;
}

/* ========================================================================
 * 百度侧
 * ====================================================================== */

export async function scanBaidu(dir: string): Promise<ScanResult> {
  const entries = await list({ dir, limit: 1000 });
  const items: ScannedItem[] = entries.map((e) => ({
    name: e.server_filename,
    isDir: e.isdir === 1,
    size: Number(e.size) || 0,
  }));

  const dirs = items.filter((i) => i.isDir);
  const files = items.filter((i) => !i.isDir);

  // 目录大小拿不到（list 对目录返回 size=0），只统计文件
  const topLevelBytes = files.reduce((s, f) => s + (f.size ?? 0), 0);

  return {
    side: 'baidu',
    root: dir,
    items,
    folders: dirs.map((d) => d.name),
    fileCount: files.length,
    dirCount: dirs.length,
    // 顶层没有文件时，用子目录个数做个提示（真实体积需要递归，成本高，不在此处做）
    sizeBytes: topLevelBytes,
  };
}

/* ========================================================================
 * 夸克侧
 * ====================================================================== */

interface QuarkRow {
  filename?: string;
  file_name?: string;
  fid?: string;
  file_type?: number | string;
  dir?: boolean;
  size?: number;
}

/** 调用夸克 CLI 的 browse，返回该目录的直接子项 */
async function browseQuark(parentFid: string): Promise<{ items: ScannedItem[]; raw: QuarkRow[] }> {
  if (!fs.existsSync(QUARK_CLI)) {
    throw new Error(`夸克 Skill CLI 不存在：${QUARK_CLI}（先安装 quarkclouddrive Skill）`);
  }
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-scan-'));

  let stdout = '';
  try {
    const r = await exec(
      process.execPath,
      [
        QUARK_CLI,
        'browse',
        '--parent-fid',
        parentFid,
        '--all',
        '--task-dir',
        taskDir,
        '--session-id',
        QUARK_SESSION,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
    );
    stdout = r.stdout ?? '';
  } catch (e: any) {
    stdout = e?.stdout ?? '';
    // 未授权时 CLI 会返回 code:-103，这里给出可操作的提示
    if (/-103|未授权|not authorized/i.test(`${e?.message ?? ''}${stdout}`)) {
      throw new Error('夸克未授权或授权已过期，请先在对话里完成夸克登录授权');
    }
  }

  // 结果写到 taskDir/browse/*.jsonl
  const browseDir = path.join(taskDir, 'browse');
  const raw: QuarkRow[] = [];
  if (fs.existsSync(browseDir)) {
    const files = fs.readdirSync(browseDir).filter((f) => f.endsWith('.jsonl')).sort();
    for (const f of files) {
      const text = fs.readFileSync(path.join(browseDir, f), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const row: QuarkRow = obj?.data?.file_list ? obj.data.file_list : obj;
          if (Array.isArray(row)) raw.push(...(row as QuarkRow[]));
          else if (row && typeof row === 'object') raw.push(row);
        } catch {
          /* 忽略解析不了的行 */
        }
      }
    }
  }

  // 去掉包裹层：有些行是 { data: { file_list: [...] } }
  const flat: QuarkRow[] = [];
  for (const r of raw) {
    const anyR = r as any;
    if (Array.isArray(anyR?.data?.file_list)) flat.push(...anyR.data.file_list);
    else if (Array.isArray(anyR?.file_list)) flat.push(...anyR.file_list);
    else if (anyR?.filename || anyR?.file_name) flat.push(r);
  }

  const items: ScannedItem[] = flat
    .map((r) => ({
      name: String(r.filename ?? r.file_name ?? ''),
      isDir: String(r.file_type) === '0' || r.dir === true,
      size: Number(r.size) || 0,
      fid: r.fid ? String(r.fid) : undefined,
    }))
    .filter((i) => i.name);

  // 清掉临时目录
  try {
    fs.rmSync(taskDir, { recursive: true, force: true });
  } catch {
    /* 清不掉不影响结果 */
  }

  return { items, raw: flat };
}

export async function scanQuark(parentFid = '0'): Promise<ScanResult> {
  const { items } = await browseQuark(parentFid);
  const dirs = items.filter((i) => i.isDir);
  const files = items.filter((i) => !i.isDir);
  return {
    side: 'quark',
    root: parentFid === '0' ? '夸克网盘/' : `fid:${parentFid}`,
    items,
    folders: dirs.map((d) => d.name),
    fileCount: files.length,
    dirCount: dirs.length,
    sizeBytes: files.reduce((s, f) => s + (f.size ?? 0), 0),
    fid: parentFid,
  };
}

/**
 * 按名称路径在夸克里逐级下钻，返回目标目录的 FID。
 * 例：['figma'] → 先在根目录找 figma，再返回它的 fid。
 */
export async function resolveQuarkFid(segments: string[]): Promise<{ fid: string; fullPath: string }> {
  let fid = '0';
  const walked: string[] = [];
  for (const seg of segments) {
    const { items } = await browseQuark(fid);
    const hit = items.find((i) => i.name === seg && i.isDir);
    if (!hit) {
      const available = items.filter((i) => i.isDir).map((i) => i.name).slice(0, 20);
      throw new Error(
        `夸克里找不到目录「${seg}」（在 ${walked.length ? walked.join('/') : '根目录'} 下）。` +
          `现有目录：${available.join('、') || '（无）'}`,
      );
    }
    fid = hit.fid ?? '0';
    walked.push(seg);
  }
  return { fid, fullPath: `夸克网盘/${walked.join('/')}` };
}

/** 扫描夸克中指定名称路径的目录 */
export async function scanQuarkByPath(segments: string[]): Promise<ScanResult & { fullPath: string }> {
  const { fid, fullPath } = await resolveQuarkFid(segments);
  const res = await scanQuark(fid);
  return { ...res, root: fullPath, fullPath, fid };
}
