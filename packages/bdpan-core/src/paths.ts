import { APP_NAME, bool } from './env';

/** 应用专属根目录：/apps/<应用名>（网盘界面显示为「我的应用数据/<应用名>」） */
export function appRoot(): string {
  const name = APP_NAME();
  if (!name) {
    throw new Error(
      '缺少 BDPAN_APP_NAME。应用名 = 网盘里「我的应用数据/<应用名>」的文件夹名，' +
        '也就是 API 路径 /apps/<应用名> 中的那一段。请在 .env 中填写后重试。',
    );
  }
  return `/apps/${name}`;
}

export function hasAppRoot(): boolean {
  return Boolean(APP_NAME());
}

/**
 * 目录范围守卫。
 *
 * ⚠️ 前提已被实测推翻（2026-10-06）：官方文档称受限接口只能访问 /apps/{appname}，
 * 但本账号实测 `create`(mkdir) 与 `filemanager`(delete/move) 在**全盘**均返回 errno=0，
 * 真正被限制的只有 `listall`。因此默认**不**启用严格模式（仅 listall 单独判断）。
 * 如需收紧，在 .env 设置 BDPAN_SCOPE_STRICT=true。
 */
export function isStrict(): boolean {
  return bool('BDPAN_SCOPE_STRICT', false);
}

/**
 * 通用路径归一化，不依赖应用名。
 * 空 / '/' / '.'  → '/'
 * '我的资源'       → '/我的资源'
 * '/我的资源'      → '/我的资源'
 */
export function normalizePath(p?: string): string {
  const raw = (p ?? '').trim();
  if (!raw || raw === '/' || raw === '.') return '/';
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, '') || '/';
}

/** 相对应用根目录归一化：'仓/待售' → '/apps/<应用名>/仓/待售' */
export function resolveAppPath(p?: string): string {
  const raw = (p ?? '').trim();
  if (!raw || raw === '/' || raw === '.') return appRoot();
  if (raw.startsWith('/')) return normalizePath(raw);
  return `${appRoot()}/${raw.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

export function isUnderApp(p: string): boolean {
  if (!hasAppRoot()) return false;
  const root = appRoot();
  return p === root || p.startsWith(`${root}/`);
}

/**
 * 受限接口的目录范围守卫。
 *
 * 实测边界（2026-10-06）：listall 走非 /apps 路径返回 errno=20020
 * 「该路径不在允许的访问范围内」；list 与 search 则不受此限，可读全盘。
 * 因此**仅**对 listall / filemanager / meta / mkdir 这类接口调用本守卫。
 */
export function assertInScope(...paths: string[]): void {
  if (!isStrict()) return;
  if (!hasAppRoot()) {
    throw new Error(
      '该接口只能访问应用专属目录 /apps/<应用名>，但未配置 BDPAN_APP_NAME，无法构造路径。',
    );
  }
  const root = appRoot();
  for (const p of paths) {
    if (p === root || p.startsWith(`${root}/`)) continue;
    throw new Error(
      `路径越界：${p}\n` +
        `该接口只允许访问 ${root} 及其子目录（openapi 限制，越界会返回 errno=20020）。\n` +
        `读取类操作请改用 bd_list / bd_search，它们不受此限制。`,
    );
  }
}

/** 展示用：把 API 路径转成网盘里的中文可见路径 */
export function toDisplayPath(p: string): string {
  return p.replace(/^\/apps\//, '我的应用数据/');
}
