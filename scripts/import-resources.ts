#!/usr/bin/env node
/**
 * 通用资源导入器 —— 把某采集器的「沙箱已出链」资源批量建成「资源条目 + 发布草稿」。
 *
 * 为什么做成通用的：此前 `assets/gfxcamp-3dmodel/build-goods.mjs` 与
 * `assets/gfxcamp-blender/build-goods.mjs` 各写一份，改一处漏一处。
 * 现在两个采集器共用这一个脚本，只靠 `--collector` / `--category` 区分。
 *
 * 用法（tsx 跑，因为要复用管理端的类型与关键词逻辑）：
 *   npx tsx scripts/import-resources.ts --collector assets/gfxcamp-3dmodel --category 3d-model --noun "3D模型素材"
 *   npx tsx scripts/import-resources.ts --collector assets/gfxcamp-blender --category blender-plugin --noun "Blender插件" --limit 50
 *   ... --dry          只打印计划，不写任何数据
 *   ... --force-draft  连已发布过的草稿也重生成（⚠️ 会清掉已确认的合规状态，默认不做）
 *
 * 幂等：已存在的资源条目不会被重建；已有草稿不会重生成（保护线上商品）。
 *
 * 顺带把「适用软件」从文章正文里探测出来写进条目（`platforms`），
 * 供标题与描述拼关键词用 —— 不少资源标题里没有软件名，只写在正文里。
 *
 * 前置：
 *   · 管理端在 127.0.0.1:8790 运行
 *   · <collector>/resources.json
 *   · <collector>/data/sandbox-share.json（由该采集器的 sandbox-share.mjs 生成）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { detectPlatforms } from '../packages/xgj-admin/src/keywords';
import { ensureAdminUp } from './lib/admin.mjs';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = 'http://127.0.0.1:8790';
const IMG_BASE = 'https://xgj.fmkj.top/goods';

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const valOf = (f: string, dft: string): string => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : dft;
};

const COLLECTOR = valOf('--collector', '');
const CATEGORY = valOf('--category', '');
const LIMIT = Number(valOf('--limit', '0')) || 0;
const DRY = has('--dry');
const FORCE_DRAFT = has('--force-draft');
const NOUN = valOf('--noun', '素材');

if (!COLLECTOR) {
  console.error('用法：npx tsx scripts/import-resources.ts --collector <dir> --category <catId> [--limit N] [--dry]');
  process.exit(1);
}
if (!CATEGORY) {
  console.error('❌ 必须指定 --category（否则会套到错误的默认价与店铺）');
  process.exit(1);
}

const CROOT = path.resolve(PROJ, COLLECTOR);
const rowsFile = path.join(CROOT, 'resources.json');
const shareFile = path.join(CROOT, 'data', 'sandbox-share.json');
for (const f of [rowsFile, shareFile]) {
  if (!fs.existsSync(f)) {
    console.error(`❌ 缺少 ${f}`);
    process.exit(1);
  }
}

const rows = JSON.parse(fs.readFileSync(rowsFile, 'utf8'));
const shares = JSON.parse(fs.readFileSync(shareFile, 'utf8'));
const byId = new Map<string, any>(rows.map((r: any) => [String(r.id), r]));

const detailFile = path.join(CROOT, 'data', 'detail.json');
const detailById = fs.existsSync(detailFile)
  ? new Map<string, any>(JSON.parse(fs.readFileSync(detailFile, 'utf8')).map((x: any) => [String(x.id), x]))
  : new Map<string, any>();

const post = async (p: string, body: unknown) => {
  const r = await fetch(`${B}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json() as any;
};

/* ---------------- 现况 ---------------- */
if (!(await ensureAdminUp())) process.exit(1);
const st0: any = await (await fetch(`${B}/api/publish/state`, { cache: 'no-store' })).json();
const existingRes = new Set<string>((st0.resources || []).map((x: any) => x.id));
const existingCode = new Map<string, string | null>(
  (st0.resources || []).map((x: any) => [x.id, x.draft_code || null]),
);
let listings: Record<string, any> = {};
try {
  listings = JSON.parse(fs.readFileSync(path.join(PROJ, 'drafts', '.listings.json'), 'utf8'));
} catch { /* 无台账 */ }

/* ---------------- 候选 ---------------- */
const candidates = Object.entries<any>(shares)
  .filter(([, s]) => s.share_url && !s.invalid)
  .map(([id, s]) => ({ id, s, r: byId.get(String(id)) }))
  .filter((x) => !!x.r)
  .sort((a, b) => Number(b.s.size_mb || 0) - Number(a.s.size_mb || 0));

const todo = LIMIT ? candidates.slice(0, LIMIT) : candidates;
console.log(
  `采集器 ${COLLECTOR}\n类别 ${CATEGORY}（副标题用词「${NOUN}」）　候选（已出链且未标 invalid）${candidates.length} 个` +
  `${LIMIT ? `　本次取前 ${todo.length}` : ''}${DRY ? '　【dry-run】' : ''}\n`,
);

/** 从标题 + 文章正文探测适用软件 */
function platformsOf(id: string): string[] {
  const r = byId.get(String(id)) as any;
  const d = detailById.get(String(id)) as any;
  const detailText = d ? [d.excerpt, d.text].filter(Boolean).join(' ').slice(0, 4000) : '';
  return detectPlatforms({ title: r?.title ?? '', detailText, down_links: r?.down_links ?? [] });
}

if (DRY) {
  for (const { id, s, r } of todo) {
    const slug = `gfx-${id}`;
    const tag = existingRes.has(slug) ? ((existingCode.get(slug) as any) ? '已有条目+草稿' : '已有条目') : '新建';
    const pl = platformsOf(id);
    console.log(
      `  ${slug.padEnd(16)} ${tag.padEnd(12)} ${String(Math.round(s.size_mb || 0)).padStart(6)} MB  ` +
      `[${pl.join('/') || '无'}]  ${String(r.title).slice(0, 34)}`,
    );
  }
  const news = todo.filter((x) => !existingRes.has(`gfx-${x.id}`)).length;
  const withPl = todo.filter((x) => platformsOf(x.id).length).length;
  console.log(`\n计划：新建条目 ${news} 个；探测到软件的 ${withPl}/${todo.length} 个；共处理 ${todo.length} 个`);
  process.exit(0);
}

/* ---------------- 执行 ---------------- */
let built = 0, drafted = 0, skipped = 0, updatedPlat = 0, fail = 0;
const errors: string[] = [];

for (const { id, s, r } of todo) {
  const slug = `gfx-${id}`;
  const pwd = (String(s.share_url).match(/[?&]pwd=([A-Za-z0-9]+)/) || [])[1] || '';
  const cleanUrl = String(s.share_url).replace(/[?&]pwd=.*$/, '');
  const nVer = s.versions_ok || s.versions || 1;
  const platforms = platformsOf(id);

  if (!existingRes.has(slug)) {
    const save = await post('/api/pipeline/resource.save', {
      id: slug,
      name: r.title,
      display_name: r.title,
      category: CATEGORY,
      platforms,
      card_subtitle: nVer > 1 ? `${nVer} 个版本可选 · ${NOUN}` : NOUN,
      notes: `来源 gfxcamp.com 文章 #${id}（第三方素材站，版权归原作者）。`,
      baidu: {
        root: s.dir || '',
        share_url: cleanUrl,
        pwd,
        expire: s.expire || '永久',
        folders: [r.title],
      },
      quark: { root: '', share_url: '', pwd: '', folders: [] },
      cover_images: [`${IMG_BASE}/${slug}.png`],
    });
    if (!save.ok) {
      console.log(`  ❌ ${slug} 建条目失败：${save.error}`);
      errors.push(`${slug}: ${save.error}`);
      fail++;
      continue;
    }
    built++;
    console.log(`  ✅ ${slug} 条目已建 [${platforms.join('/') || '无'}]（${save.message}）`);
  } else {
    // 已存在的条目：只补 platforms。
    // ⚠️ 必须**整条回传**！`resource.save` 走 normalizeResourceInput，
    //    它对未传的字段会写成空值（cover_images→[]、draft_code→undefined），
    //    只传 { id, platforms } 会顺手清掉草稿关联与封面图 —— 已上架商品会因此
    //    变成「未发布」，再次点发布就重复创建商品。
    const cur: any = (st0.resources || []).find((x: any) => x.id === slug);
    if (platforms.length && !(cur?.platforms?.length)) {
      const save = await post('/api/pipeline/resource.save', { ...cur, platforms });
      if (save.ok) updatedPlat++;
      else console.log(`  ⚠️ ${slug} 补软件字段失败：${save.error}`);
    }
  }

  // 草稿：已发布的绝不重生成（会清掉已确认的合规状态）
  const code = existingCode.get(slug) || `BD-${slug.toUpperCase()}`;
  if (listings[code] && !FORCE_DRAFT) {
    skipped++;
    continue;
  }
  const gen = await post('/api/pipeline/draft.generate', {
    id: slug,
    overwrite: existingCode.get(slug) ? FORCE_DRAFT : true,
  });
  if (gen.ok) {
    drafted++;
    if (drafted % 20 === 0) console.log(`  …已生成 ${drafted} 个草稿`);
  } else {
    console.log(`  ❌ ${slug} 草稿失败：${gen.error}`);
    errors.push(`${slug}: ${gen.error}`);
    fail++;
  }
}

console.log(`\n新建条目 ${built} · 补软件字段 ${updatedPlat} · 生成草稿 ${drafted} · 跳过(已发布) ${skipped} · 失败 ${fail}`);
if (errors.length) {
  console.log('\n失败明细（前 15 条）：');
  for (const e of errors.slice(0, 15)) console.log('  ' + e);
}

const st: any = await (await fetch(`${B}/api/publish/state`, { cache: 'no-store' })).json();
console.log('\n队列现状：', JSON.stringify(st.stats));
void pathToFileURL;
