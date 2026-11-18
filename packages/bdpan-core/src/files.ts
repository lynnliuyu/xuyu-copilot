import { panGet, panPostForm, panPostMixed } from './http';
import { getAccessToken } from './token';
import { RateLimiter } from './ratelimit';
import { assertInScope, normalizePath, resolveAppPath, toDisplayPath } from './paths';
import { opt } from './env';
import { sleep } from './errors';

export const CATEGORY: Record<number, string> = {
  1: '视频',
  2: '音频',
  3: '图片',
  4: '文档',
  5: '应用',
  6: '其他',
  7: '种子',
};

export interface FileEntry {
  fs_id: number;
  path: string;
  server_filename: string;
  size: number;
  isdir: 0 | 1;
  category?: number;
  md5?: string;
  server_ctime?: number;
  server_mtime?: number;
  thumbs?: Record<string, string>;
}

export interface UserInfo {
  baidu_name?: string;
  netdisk_name?: string;
  avatar_url?: string;
  vip_type?: number;
  uk?: number;
}

let listallLimiter: RateLimiter | null = null;
function getListallLimiter(): RateLimiter {
  if (!listallLimiter) {
    listallLimiter = new RateLimiter(Number(opt('BDPAN_LISTALL_INTERVAL_MS', '6500')));
  }
  return listallLimiter;
}

/** 用户信息，同时用于校验 access_token 是否有效 */
export async function uinfo(): Promise<UserInfo> {
  const access_token = await getAccessToken();
  return (await panGet('/rest/2.0/xpan/nas', { method: 'uinfo', access_token })) as UserInfo;
}

/** 容量信息 */
export async function quota(): Promise<{ total: number; used: number; free: number }> {
  const access_token = await getAccessToken();
  return (await panGet('/api/quota', { access_token })) as { total: number; used: number; free: number };
}

export interface ListOptions {
  dir?: string;
  order?: 'name' | 'time' | 'size';
  desc?: 0 | 1;
  start?: number;
  limit?: number;
  folder?: 0 | 1;
  web?: 0 | 1;
}

/**
 * 列目录（单层）。对应 /xpan/file?method=list
 *
 * 注意：list **不在**官方的目录限制名单内，实测可访问全盘任意目录。
 */
export async function list(opts: ListOptions = {}): Promise<FileEntry[]> {
  const access_token = await getAccessToken();
  const dir = normalizePath(opts.dir);
  const json = await panGet('/rest/2.0/xpan/file', {
    method: 'list',
    access_token,
    dir,
    order: opts.order ?? 'name',
    desc: opts.desc ?? 0,
    start: opts.start ?? 0,
    limit: opts.limit ?? 1000,
    folder: opts.folder ?? 0,
    web: opts.web ?? 0,
  });
  return (json.list ?? []) as FileEntry[];
}

export interface ListAllOptions {
  path?: string;
  recursion?: 0 | 1;
  order?: 'name' | 'time' | 'size';
  desc?: 0 | 1;
  max?: number;
  onPage?: (count: number, total: number) => void;
}

/**
 * 递归列目录。对应 /xpan/multimedia?method=listall
 *
 * ⚠️ 该接口**仅允许访问 /apps/{appname}**，实测访问其他路径返回 errno=20020。
 * 需要遍历 /apps 之外的目录时，请改用 walkTree()（基于 list 自建遍历）。
 */
export async function listAll(opts: ListAllOptions = {}): Promise<FileEntry[]> {
  const access_token = await getAccessToken();
  const root = resolveAppPath(opts.path);
  assertInScope(root);
  const limiter = getListallLimiter();
  const max = opts.max ?? 50000;

  const out: FileEntry[] = [];
  let start = 0;
  for (;;) {
    const json = await limiter.run(() =>
      panGet('/rest/2.0/xpan/multimedia', {
        method: 'listall',
        access_token,
        path: root,
        recursion: opts.recursion ?? 1,
        order: opts.order ?? 'name',
        desc: opts.desc ?? 0,
        start,
        limit: 1000,
      }),
    );
    const batch = (json.list ?? []) as FileEntry[];
    out.push(...batch);
    opts.onPage?.(batch.length, out.length);
    if (out.length >= max) break;
    if (Number(json.has_more) !== 1) break;
    const cursor = Number(json.cursor ?? 0);
    if (!cursor || cursor <= start) break;
    start = cursor;
  }
  return out.slice(0, max);
}

export interface WalkOptions {
  /** 起始目录，默认 '/'（全盘） */
  root?: string;
  /** 最多返回条目数 */
  max?: number;
  /** 每次 list 调用之间的间隔（毫秒），用于规避频控 */
  intervalMs?: number;
  /** 只遍历到该深度（1 = 仅起始目录） */
  maxDepth?: number;
  onDir?: (dir: string, filesInDir: number, totalFiles: number) => void;
  onPage?: (total: number) => void;
}

/**
 * 基于 list 自建的递归遍历（广度优先）。
 *
 * 为什么需要它：listall 被限制在 /apps/{appname}，无法遍历用户网盘的其余目录；
 * 而 list 不受限制。逐层 list 即可覆盖全盘，代价是请求次数更多（默认 150ms 间隔）。
 */
export async function walkTree(opts: WalkOptions = {}): Promise<FileEntry[]> {
  const root = normalizePath(opts.root);
  const max = opts.max ?? 20000;
  const interval = opts.intervalMs ?? 150;
  const maxDepth = opts.maxDepth ?? Number.MAX_SAFE_INTEGER;

  const out: FileEntry[] = [];
  let totalFiles = 0;
  const visited = new Set<string>();
  let frontier: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 1 }];

  while (frontier.length && out.length < max) {
    const next: Array<{ dir: string; depth: number }> = [];
    for (const { dir, depth } of frontier) {
      if (visited.has(dir)) continue;
      visited.add(dir);

      let start = 0;
      let filesInDir = 0;
      const subdirs: string[] = [];
      for (;;) {
        const batch = await list({ dir, start, limit: 1000, order: 'name' });
        for (const e of batch) {
          if (out.length >= max) break;
          out.push(e);
          if (e.isdir === 1) subdirs.push(e.path);
          else {
            filesInDir += 1;
            totalFiles += 1;
          }
        }
        opts.onPage?.(out.length);
        if (out.length >= max || batch.length < 1000) break;
        start += batch.length;
        await sleep(interval);
      }

      opts.onDir?.(dir, filesInDir, totalFiles);
      if (depth < maxDepth) for (const d of subdirs) next.push({ dir: d, depth: depth + 1 });
      if (out.length >= max) break;
      await sleep(interval);
    }
    frontier = next;
  }
  return out;
}

/** 按关键词搜索。对应 /xpan/file?method=search（同样不受 /apps 限制） */
export async function search(opts: {
  key: string;
  dir?: string;
  recursion?: 0 | 1;
  page?: number;
  num?: number;
}): Promise<FileEntry[]> {
  const access_token = await getAccessToken();
  const dir = normalizePath(opts.dir);
  const json = await panGet('/rest/2.0/xpan/file', {
    method: 'search',
    access_token,
    key: opts.key,
    dir,
    recursion: opts.recursion ?? 1,
    page: opts.page ?? 1,
    num: opts.num ?? 500,
  });
  return (json.list ?? []) as FileEntry[];
}

/** 批量取文件元信息。对应 /xpan/multimedia?method=filemetas */
export async function meta(fsids: number[], opts: { dlink?: 0 | 1; thumb?: 0 | 1 } = {}): Promise<any[]> {
  const access_token = await getAccessToken();
  const json = await panGet('/rest/2.0/xpan/multimedia', {
    method: 'filemetas',
    access_token,
    fsids: JSON.stringify(fsids),
    dlink: opts.dlink ?? 0,
    thumb: opts.thumb ?? 0,
  });
  return json.info ?? [];
}

/** 创建目录。对应 /xpan/file?method=create + isdir=1（仅限应用目录） */
export async function mkdir(dirPath: string): Promise<{ fs_id: number; path: string }> {
  const access_token = await getAccessToken();
  const target = resolveAppPath(dirPath);
  assertInScope(target);
  return (await panPostForm('/rest/2.0/xpan/file', {
    method: 'create',
    access_token,
    path: target,
    isdir: 1,
    rtype: 0,
  })) as { fs_id: number; path: string };
}

export type FileManagerOpera = 'copy' | 'move' | 'rename' | 'delete';

export interface FileManagerItem {
  path: string;
  dest?: string;
  newname?: string;
  ondup?: 'overwrite' | 'newcopy' | 'skip' | 'fail';
}

/**
 * 文件管理：复制 / 移动 / 重命名 / 删除。对应 /xpan/file?method=filemanager
 *
 * 实测（2026-10-06）：本账号在全盘均可执行，不受 /apps 限制。
 * 参数位置是关键：`method`/`opera`/`async` 走 query，`filelist` 走 body。
 * 删除进入网盘回收站，可恢复。
 */
export async function filemanager(
  opera: FileManagerOpera,
  items: FileManagerItem[],
): Promise<{ info?: Array<{ errno: number; path: string }>; taskid?: number }> {
  const access_token = await getAccessToken();
  const filelist = items.map((it) => {
    const p = normalizePath(it.path);
    const entry: Record<string, string> = { path: p };
    if (it.dest) entry.dest = normalizePath(it.dest);
    if (it.newname) entry.newname = it.newname;
    if (it.ondup) entry.ondup = it.ondup;
    return entry;
  });

  return (await panPostMixed(
    '/rest/2.0/xpan/file',
    { method: 'filemanager', access_token, opera, async: 0 },
    { filelist: JSON.stringify(filelist) },
  )) as { info?: Array<{ errno: number; path: string }>; taskid?: number };
}

export { toDisplayPath };
