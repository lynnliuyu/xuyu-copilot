import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  list,
  listAll,
  walkTree,
  search,
  meta,
  mkdir,
  filemanager,
  uinfo,
  quota,
  createShare,
  randomPwd,
  tokenStatus,
  appRoot,
  hasAppRoot,
  isUnderApp,
  normalizePath,
  toDisplayPath,
  shareEnabled,
} from '../../bdpan-core/src/index';

const server = new McpServer({ name: 'bdpan', version: '0.1.0' });

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (err: unknown) => ({
  content: [{ type: 'text' as const, text: `失败：${(err as Error)?.message ?? String(err)}` }],
  isError: true,
});

function human(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

const CATEGORY: Record<number, string> = { 1: '视频', 2: '音频', 3: '图片', 4: '文档', 5: '应用', 6: '其他', 7: '种子' };

function formatEntries(entries: any[]): string {
  if (!entries.length) return '（空）';
  const lines = entries.map((e) => {
    const kind = e.isdir === 1 ? 'DIR ' : 'FILE';
    const size = e.isdir === 1 ? '        -' : human(e.size ?? 0).padStart(9);
    const cat = e.isdir === 1 ? '    ' : (CATEGORY[e.category ?? 0] ?? '未知').padEnd(4);
    return `${kind} ${size} ${cat} ${toDisplayPath(e.path)}`;
  });
  return lines.join('\n');
}

// ---------- 只读工具 ----------

server.tool('bd_status', '查看令牌状态、应用根目录与账号容量', {}, async () => {
  try {
    const info = await uinfo();
    const q = await quota();
    return ok(
      [
        `令牌状态   : ${tokenStatus()}`,
        `应用根目录 : ${appRoot()}（网盘内显示为 ${toDisplayPath(appRoot())}）`,
        `网盘用户名 : ${info.netdisk_name ?? '-'}`,
        `VIP 类型   : ${info.vip_type ?? '-'}`,
        `容量       : 总 ${human(q.total)} / 已用 ${human(q.used)} / 剩余 ${human(q.free)}`,
        `分享能力   : ${shareEnabled() ? '已开启' : '未开启（付费+企业开发者专属）'}`,
      ].join('\n'),
    );
  } catch (e) {
    return fail(e);
  }
});

server.tool(
  'bd_list',
  '列出应用根目录下某一层目录的内容（不递归）。路径可传相对路径，如 "仓/待售"',
  {
    dir: z.string().optional().describe('目录路径，留空表示应用根目录'),
    order: z.enum(['name', 'time', 'size']).optional(),
    desc: z.union([z.literal(0), z.literal(1)]).optional(),
    limit: z.number().optional().describe('返回条数，默认 1000'),
  },
  async ({ dir, order, desc, limit }) => {
    try {
      const entries = await list({ dir, order, desc, limit });
      return ok(`共 ${entries.length} 条：\n${formatEntries(entries)}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'bd_list_recursive',
  '递归列出目录下的所有文件与目录。自动选择遍历方式：应用目录内走 listall 递归接口，应用目录外走 list 自建 BFS（因为 listall 仅允许 /apps/{appname}）',
  {
    path: z.string().optional().describe('起始目录，默认 "/" 表示整个网盘'),
    max: z.number().optional().describe('最多返回条数，默认 5000，保护性上限'),
    mode: z.enum(['auto', 'list', 'listall']).optional().describe('遍历方式，默认 auto'),
  },
  async ({ path, max, mode }) => {
    try {
      const root = normalizePath(path);
      const useListall =
        mode === 'listall' || (mode !== 'list' && hasAppRoot() && isUnderApp(root));
      const limit = max ?? 5000;
      const entries = useListall
        ? await listAll({ path: root, recursion: 1, max: limit })
        : await walkTree({ root, max: limit, intervalMs: 120 });

      const fileList = entries.filter((e) => e.isdir === 0);
      const dirList = entries.filter((e) => e.isdir === 1);
      const size = fileList.reduce((a, e) => a + (e.size ?? 0), 0);

      // 顶层目录概览，便于 AI 直接理解结构
      const top = new Map<string, { files: number; size: number }>();
      for (const f of fileList) {
        const segs = f.path.split('/').filter(Boolean);
        const key = segs.length > 1 ? segs[0] : '(根目录)';
        const t = top.get(key) ?? { files: 0, size: 0 };
        t.files += 1;
        t.size += f.size ?? 0;
        top.set(key, t);
      }
      const overview = [...top]
        .sort((a, b) => b[1].size - a[1].size)
        .map(([k, v]) => `  ${human(v.size).padStart(10)}  ${String(v.files).padStart(6)} 文件  ${k}`)
        .join('\n');

      const preview = entries.slice(0, 60);
      const more = entries.length > preview.length ? `\n... 另外 ${entries.length - preview.length} 条未展示` : '';

      return ok(
        `遍历方式：${useListall ? 'listall' : 'list BFS'}\n` +
          `结果：文件 ${fileList.length} 个 / 目录 ${dirList.length} 个，合计 ${human(size)}\n\n` +
          `顶层概览：\n${overview}\n\n` +
          `明细（前 60 条）：\n${formatEntries(preview)}${more}`,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'bd_search',
  '按文件名关键词搜索',
  {
    key: z.string().describe('搜索关键词'),
    dir: z.string().optional().describe('搜索起点目录，留空表示应用根目录'),
    recursion: z.union([z.literal(0), z.literal(1)]).optional(),
    num: z.number().optional(),
  },
  async ({ key, dir, recursion, num }) => {
    try {
      const entries = await search({ key, dir, recursion, num });
      return ok(`命中 ${entries.length} 条：\n${formatEntries(entries.slice(0, 300))}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'bd_meta',
  '批量查询文件元信息（含缩略图与下载直链）',
  {
    fsids: z.array(z.number()).describe('文件 fs_id 列表'),
    dlink: z.union([z.literal(0), z.literal(1)]).optional().describe('是否返回下载直链'),
    thumb: z.union([z.literal(0), z.literal(1)]).optional().describe('是否返回缩略图'),
  },
  async ({ fsids, dlink, thumb }) => {
    try {
      const infos = await meta(fsids, { dlink, thumb });
      return ok(JSON.stringify(infos, null, 2).slice(0, 8000));
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------- 写入工具（默认 dry_run，不真的执行）----------

const dryRunNote = (action: string, detail: string) =>
  ok(`[dry_run] 未执行任何写操作。\n将执行：${action}\n目标：\n${detail}\n\n确认无误后请以 dry_run=false 重新调用。`);

server.tool(
  'bd_mkdir',
  '创建目录。默认 dry_run=true 只预览不执行',
  {
    path: z.string().describe('要创建的目录'),
    dry_run: z.boolean().optional().describe('默认 true；false 才会真正执行'),
  },
  async ({ path, dry_run }) => {
    try {
      if (dry_run !== false) return dryRunNote('创建目录', path);
      const r = await mkdir(path);
      return ok(`已创建目录：${r.path}（fs_id=${r.fs_id}）`);
    } catch (e) {
      return fail(e);
    }
  },
);

function writeOpTool(
  name: string,
  description: string,
  opera: 'move' | 'rename' | 'copy' | 'delete',
  shape: z.ZodRawShape,
) {
  server.tool(name, description, shape, async (args: any) => {
    try {
      const items =
        opera === 'rename'
          ? [{ path: args.path, newname: args.newname }]
          : opera === 'delete'
            ? [{ path: args.path }]
            : [{ path: args.path, dest: args.dest }];
      const detail = items.map((i: any) => JSON.stringify(i)).join('\n');
      if (args.dry_run !== false) return dryRunNote(`${opera}`, detail);
      const r = await filemanager(opera, items as any);
      return ok(`已执行 ${opera}。返回：\n${JSON.stringify(r ?? {}, null, 2).slice(0, 4000)}`);
    } catch (e) {
      return fail(e);
    }
  });
}

writeOpTool('bd_move', '移动文件或目录（默认 dry_run=true）', 'move', {
  path: z.string().describe('源路径'),
  dest: z.string().describe('目标目录'),
  dry_run: z.boolean().optional(),
});

writeOpTool('bd_copy', '复制文件或目录（默认 dry_run=true）', 'copy', {
  path: z.string().describe('源路径'),
  dest: z.string().describe('目标目录'),
  dry_run: z.boolean().optional(),
});

writeOpTool('bd_rename', '重命名（默认 dry_run=true）', 'rename', {
  path: z.string().describe('源路径'),
  newname: z.string().describe('新文件名'),
  dry_run: z.boolean().optional(),
});

writeOpTool('bd_delete', '删除到回收站（默认 dry_run=true，危险操作）', 'delete', {
  path: z.string().describe('要删除的路径'),
  dry_run: z.boolean().optional(),
});

// ---------- money 档：付费能力 ----------

server.tool(
  'bd_share_create',
  '【付费能力】为文件创建分享链接并生成提取码。需已开通百度网盘文件分享服务（企业开发者专属），未开通会返回 errno=13998',
  {
    fsids: z.array(z.number()).describe('要分享的文件 fs_id 列表'),
    period: z.number().describe('有效期，单位天'),
    pwd: z.string().optional().describe('提取码，4 位数字或小写字母；不传则随机生成'),
    remark: z.string().optional(),
    dry_run: z.boolean().optional().describe('默认 true；false 才会真正调用付费接口'),
  },
  async ({ fsids, period, pwd, remark, dry_run }) => {
    if (dry_run !== false) {
      return ok(
        `[dry_run] 未调用分享接口。\n将创建分享：fsids=${JSON.stringify(fsids)} period=${period}天 pwd=${pwd ?? randomPwd(4)}\n\n` +
          `注意：该接口为付费能力且属企业开发者专属权益，未开通会返回 errno=13998。`,
      );
    }
    try {
      const r = await createShare({ fsids, period, pwd: pwd ?? randomPwd(4), remark });
      return ok(`分享创建成功：\n链接：${r.link}\n提取码：${r.pwd}\n有效期：${r.period} 天\nshare_id：${r.share_id}`);
    } catch (e) {
      return fail(e);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[bdpan-mcp] MCP 服务已启动（stdio）\n');
