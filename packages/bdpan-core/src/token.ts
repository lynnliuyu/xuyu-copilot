import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_KEY, SECRET_KEY, REDIRECT_URI, SCOPE } from './env';
import { OAUTH_BASE, oauthToken } from './http';
import { sleep } from './errors';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const TOKEN_FILE = path.join(ROOT, '.tokens.json');

/** access_token 剩余不足该毫秒数时自动刷新（默认 3 天） */
const REFRESH_MARGIN_MS = 3 * 24 * 60 * 60 * 1000;

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  /** Unix 毫秒时间戳 */
  expires_at: number;
  scope?: string;
  obtained_at: number;
  refreshed_at?: number;
}

export function loadToken(): TokenSet | null {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (!raw?.access_token || !raw?.refresh_token) return null;
    return raw as TokenSet;
  } catch {
    return null;
  }
}

export function saveToken(t: TokenSet): void {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
}

function normalize(json: any, prev?: TokenSet | null): TokenSet {
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? prev?.refresh_token ?? '',
    expires_at: Date.now() + Number(json.expires_in ?? 2592000) * 1000,
    scope: json.scope,
    obtained_at: prev?.obtained_at ?? Date.now(),
    refreshed_at: prev ? Date.now() : undefined,
  };
}

/** 生成授权链接。redirect_uri 为 oob 时，百度会在页面上直接展示授权码。 */
export function buildAuthUrl(redirectUri = REDIRECT_URI()): string {
  const sp = new URLSearchParams({
    response_type: 'code',
    client_id: APP_KEY(),
    redirect_uri: redirectUri,
    scope: SCOPE,
    display: 'page',
  });
  return `${OAUTH_BASE}/oauth/2.0/authorize?${sp.toString()}`;
}

/** 从用户粘贴的内容里提取授权码：支持纯 code，也支持整条回调 URL */
export function extractCode(input: string): string {
  const s = input.trim();
  try {
    const u = new URL(s);
    const code = u.searchParams.get('code');
    if (code) return code;
  } catch {
    /* 不是 URL，按纯 code 处理 */
  }
  return s;
}

export async function exchangeCode(code: string, redirectUri = REDIRECT_URI()): Promise<TokenSet> {
  const json = await oauthToken({
    grant_type: 'authorization_code',
    code,
    client_id: APP_KEY(),
    client_secret: SECRET_KEY(),
    redirect_uri: redirectUri,
  });
  const t = normalize(json);
  saveToken(t);
  return t;
}

/**
 * 刷新 access_token。
 * 注意：百度返回的 refresh_token 是**一次性**的，刷新后会轮换，必须立即落盘。
 */
export async function refreshAccessToken(): Promise<TokenSet> {
  const prev = loadToken();
  if (!prev?.refresh_token) {
    throw new Error('没有可用的 refresh_token，请先执行 npm run auth 重新授权');
  }
  const json = await oauthToken({
    grant_type: 'refresh_token',
    refresh_token: prev.refresh_token,
    client_id: APP_KEY(),
    client_secret: SECRET_KEY(),
  });
  const t = normalize(json, prev);
  saveToken(t);
  return t;
}

/** 取一个可用的 access_token，临近过期自动刷新 */
export async function getAccessToken(): Promise<string> {
  const t = loadToken();
  if (!t) {
    throw new Error('尚未授权。请先执行 npm run auth 完成一次浏览器授权。');
  }
  if (Date.now() >= t.expires_at - REREFRESH_SAFE) {
    const refreshed = await refreshWithRetry();
    return refreshed.access_token;
  }
  return t.access_token;
}

const REREFRESH_SAFE = REFRESH_MARGIN_MS;

async function refreshWithRetry(attempts = 3): Promise<TokenSet> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await refreshAccessToken();
    } catch (err) {
      lastErr = err;
      await sleep(1000 * (i + 1));
    }
  }
  throw new Error(
    `access_token 刷新失败，需要人工重新授权（npm run auth）。原始错误：${(lastErr as Error)?.message}`,
  );
}

export function tokenStatus(): string {
  const t = loadToken();
  if (!t) return '未授权';
  const leftDays = ((t.expires_at - Date.now()) / 86400000).toFixed(2);
  return `已授权，access_token 剩余约 ${leftDays} 天`;
}
