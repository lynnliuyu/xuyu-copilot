/**
 * 图片托管 —— 把本地生成的商品图推到自有服务器的静态目录，换取公网 URL。
 *
 * 为什么必须是自有服务器：
 *   · Gitee 早已封掉外链（302 跳到 15 分钟有效的签名链接 + 站外 Referer 直接 403）
 *   · sm.ms / 路过图床实测不可用（404 / 连不上）
 *   · 闲鱼抓图是**服务端行为**，要的是一个稳定、无防盗链、国内可达的公网地址
 *
 * 上传走 scp，域名与路径全部从 .env 读 —— 换服务器只改配置，不动代码。
 *
 * .env 需要：
 *   MEDIA_SSH_TARGET = ubuntu@150.158.3.164
 *   MEDIA_SSH_KEY    = /path/to/workbuddykaifa.pem
 *   MEDIA_REMOTE_DIR = /srv/goods-img
 *   MEDIA_PUBLIC_BASE= https://xgj.fmkj.top/goods
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { opt } from '../../bdpan-core/src/env';

const exec = promisify(execFile);

/** 生成的商品图落这里（本地中转目录） */
export const MEDIA_LOCAL_DIR = path.join(
  path.dirname(new URL('../../../../', import.meta.url).pathname),
  'assets',
  'goods',
);

export interface MediaConfig {
  target: string;
  key: string;
  remoteDir: string;
  publicBase: string;
}

export function mediaConfig(): MediaConfig {
  return {
    target: opt('MEDIA_SSH_TARGET'),
    key: opt('MEDIA_SSH_KEY'),
    remoteDir: opt('MEDIA_REMOTE_DIR', '/srv/goods-img'),
    publicBase: opt('MEDIA_PUBLIC_BASE').replace(/\/+$/, ''),
  };
}

export interface MediaReadiness {
  ready: boolean;
  missing: string[];
}

export function mediaReady(): MediaReadiness {
  const c = mediaConfig();
  const missing: string[] = [];
  if (!c.target) missing.push('MEDIA_SSH_TARGET');
  if (!c.key) missing.push('MEDIA_SSH_KEY');
  else if (!fs.existsSync(c.key)) missing.push(`MEDIA_SSH_KEY 指向的文件不存在：${c.key}`);
  if (!c.publicBase) missing.push('MEDIA_PUBLIC_BASE');
  return { ready: missing.length === 0, missing };
}

export function publicUrl(filename: string): string {
  const c = mediaConfig();
  return `${c.publicBase}/${encodeURIComponent(filename)}`;
}

/** 文件名安全化：保留中文、字母数字、点、横线、下划线；其余换成 - */
export function safeName(name: string): string {
  return name
    .normalize('NFC')
    .replace(/\.\./g, '')
    .replace(/[^\w\u4e00-\u9fa5.\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const SSH_OPTS = [
  '-o', 'IdentitiesOnly=yes', // ⚠️ 必须：否则本机 ssh-agent 会插一脚，key 被忽略
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'ConnectTimeout=20',
];

export interface UploadResult {
  filename: string;
  url: string;
  bytes: number;
  remotePath: string;
}

/**
 * 上传一张本地图片到服务器静态目录。
 *
 * 会依次做：确保远端目录存在 → scp 上传 → 校正权限（目录 755 / 文件 644）。
 * 返回可直接写进草稿 cover_images 的公网 URL。
 */
export async function uploadImage(localPath: string, remoteName?: string): Promise<UploadResult> {
  const c = mediaConfig();
  const ready = mediaReady();
  if (!ready.ready) {
    throw new Error(`图床未配置好，缺少：${ready.missing.join('、')}（在 .env 里补上）`);
  }
  if (!fs.existsSync(localPath)) throw new Error(`本地图片不存在：${localPath}`);

  const filename = safeName(remoteName || path.basename(localPath));
  const remotePath = `${c.remoteDir}/${filename}`;

  const ssh = (cmd: string) => exec('ssh', ['-i', c.key, ...SSH_OPTS, c.target, cmd], { timeout: 60_000 });

  // 1) 确保远端目录存在（-p 幂等）
  await ssh(`mkdir -p ${shellQuote(c.remoteDir)}`);

  // 2) 上传
  await exec('scp', ['-i', c.key, ...SSH_OPTS, localPath, `${c.target}:${remotePath}`], { timeout: 180_000 });

  // 3) 权限：静态文件要 www-data / nobody 能读
  await ssh(`chmod 644 ${shellQuote(remotePath)} && chmod 755 ${shellQuote(c.remoteDir)}`);

  const bytes = fs.statSync(localPath).size;
  return { filename, url: publicUrl(filename), bytes, remotePath };
}

/** 只测连通性，不上传 —— 用于「测试图床」按钮 */
export async function pingMedia(): Promise<{ ok: boolean; message: string; detail?: string }> {
  const c = mediaConfig();
  const ready = mediaReady();
  if (!ready.ready) return { ok: false, message: `图床未配置：${ready.missing.join('、')}` };
  try {
    const { stdout } = await exec(
      'ssh',
      ['-i', c.key, ...SSH_OPTS, c.target, `mkdir -p ${shellQuote(c.remoteDir)} && echo __PONG__`],
      { timeout: 40_000 },
    );
    if (!String(stdout).includes('__PONG__')) return { ok: false, message: `SSH 通了但命令没回执：${String(stdout).slice(0, 120)}` };
    return { ok: true, message: `SSH 与远端目录均正常：${c.target}:${c.remoteDir}`, detail: `公网前缀 ${c.publicBase}` };
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || e);
    let hint = '';
    if (/Permission denied/i.test(msg)) hint = '（私钥不对或无权限）';
    else if (/Connection refused|timed out|No route/i.test(msg)) hint = '（网络不通，或服务器还在重置中）';
    else if (/Host key verification/i.test(msg)) hint = '（首次连接的主机指纹未接受）';
    return { ok: false, message: `SSH 失败：${msg.split('\n')[0]} ${hint}` };
  }
}

/** 给远端命令做 shell 转义（路径里可能有空格/中文） */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 确保本地中转目录存在 */
export function ensureLocalDir(): string {
  fs.mkdirSync(MEDIA_LOCAL_DIR, { recursive: true });
  return MEDIA_LOCAL_DIR;
}
