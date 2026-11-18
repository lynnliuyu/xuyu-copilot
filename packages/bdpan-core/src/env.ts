import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

// 仓库根目录的 .env（本文件位于 packages/bdpan-core/src/，向上三层即根目录）
const rootEnvPath = fileURLToPath(new URL('../../../.env', import.meta.url));
config({ path: rootEnvPath, quiet: true });
// 允许当前工作目录下的 .env 覆盖（不覆盖已存在的键）
config({ quiet: true });

export function opt(key: string, fallback = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

export function req(key: string): string {
  const v = opt(key);
  if (!v) {
    throw new Error(`缺少环境变量 ${key}。请在仓库根目录的 .env 中配置（参考 .env.example）。`);
  }
  return v;
}

export function bool(key: string, fallback: boolean): boolean {
  const v = opt(key);
  if (!v) return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

export const APP_ID = () => req('BDPAN_APP_ID');
export const APP_KEY = () => req('BDPAN_APP_KEY');
export const SECRET_KEY = () => req('BDPAN_SECRET_KEY');
export const SIGN_KEY = () => opt('BDPAN_SIGN_KEY');
export const APP_NAME = () => opt('BDPAN_APP_NAME');
export const REDIRECT_URI = () => opt('BDPAN_REDIRECT_URI') || 'oob';
export const SCOPE = 'basic,netdisk';
