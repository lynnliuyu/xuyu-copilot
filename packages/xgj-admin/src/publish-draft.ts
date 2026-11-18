/**
 * 发布草稿生成 —— 把「资源条目」翻译成 goofish-adapter 能直接上架的商品草稿。
 *
 * 两条设计原则：
 *
 * 1. **复用已验证的配置。** 类目 / 店铺 / 省市区不是猜的，是 2026-10-07 那次
 *    真实上架成功（product_status=22）时用的那一组。改这些值之前请先想清楚，
 *    它们决定了「能不能上架」。
 *
 * 2. **生成的是初稿，不是终稿。** 标题、描述、价格都只是起点，页面里可以改。
 *    尤其标题 —— 闲鱼对字数有硬性算法，机器拼出来的顶多算「合规的占位」。
 *
 * ⚠️ 商品描述里**不放分享链接**：链接是发货内容，写进描述等于让买家不买也能拿到。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DRAFTS_DIR, categoryOf, defaultPriceFor, type ResourceEntry } from './resources';
import { buildTitle, keywordLine } from './keywords';

/**
 * 已验证可上架的发布参数（2026-10-07 实测 product_status=22）。
 * 「其他程序/软件开发」是店内同类在售商品正在用的类目，且无必填属性。
 */
export const VERIFIED_PUBLISH_CONFIG = {
  item_biz_type: 2,
  sp_biz_type: 21,
  channel_cat_id: 'c6bda54f97ed3234267e0a01017d9f44', // 其他程序/软件开发
  user_name: '顺和服饰平价超市',
  province: 430000,
  city: 430100,
  district: 430102,
} as const;

/**
 * ⚠️ 权重与截断的实现已统一到 `keywords.ts`（此前这里有第二份副本，容易改一处漏一处）。
 * 这里只做转发，保持既有引用不断。
 */
export { titleWeight, clampTitle } from './keywords';

/** 商品编码：BD-<资源 id 大写> */
export function draftCodeFor(r: ResourceEntry): string {
  const slug = r.id
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `BD-${slug}`;
}

function defaultTitle(r: ResourceEntry): string {
  // 关键词策略见 keywords.ts：核心名 + 平台/品类词 + 用途属性词，
  // 目的是让标题同时命中「3D模型」「Blender模型素材」这类站内高频搜索词。
  return buildTitle(r);
}

function defaultContent(r: ResourceEntry): string {
  const b = r.baidu ?? ({ folders: [] } as any);
  const q = r.quark ?? ({ folders: [] } as any);
  const folders = (b.folders?.length ? b.folders : q.folders) ?? [];
  const lines: string[] = [];

  lines.push(`【${r.display_name || r.name}】`);
  lines.push('');

  // ⚠️ 关键词块放最前面而不是末尾：闲鱼详情页默认只展示前几行，
  // 放开头才能被看到、也更容易进站内搜索的文本索引。
  lines.push(keywordLine(r));
  lines.push('');

  if (folders.length) {
    lines.push('■ 包含内容');
    for (const f of folders) lines.push(`· ${f}`);
    lines.push('');
  }

  // 描述里不写链接本身（那是发货内容），但要如实说明会发哪种网盘的链接
  const sides = [
    b.share_url?.trim() ? '百度网盘' : '',
    q.share_url?.trim() ? '夸克网盘' : '',
  ].filter(Boolean);

  lines.push('■ 获取方式');
  if (sides.length > 1) {
    lines.push(`拍下后自动发货，同时提供 ${sides.join(' / ')} 两种下载链接，任选一个转存即可。`);
  } else if (sides.length === 1) {
    lines.push(`拍下后自动发货，提供${sides[0]}下载链接。`);
  } else {
    lines.push('拍下后自动发货，请查看订单页给出的下载地址。');
  }
  lines.push('');

  lines.push('■ 使用说明');
  let step = 1;
  lines.push(`${step++}. 建议先转存到你自己的网盘再下载，避免链接失效`);
  if ([b, q].some((s) => s.share_url?.trim() && s.pwd?.trim())) {
    lines.push(`${step++}. 打开链接如提示输入提取码，已在发货内容里一并给出`);
  }
  lines.push(`${step++}. 虚拟商品，发出后不支持退款，介意勿拍`);
  lines.push('');

  // ⚠️ notes 是**内部备注**（版权结论、待办等），绝不能进商品描述 ——
  // 那是买家能看到的正文。2026-10-07 踩过：版权提示被写进了商品详情。

  return lines.join('\n').trim();
}

export interface GeneratedDraft {
  file: string;
  draft: Record<string, unknown>;
}

/**
 * 由资源条目生成商品草稿并写入 drafts/<code>.json。
 *
 * @param overwrite 已存在同名草稿时是否覆盖。默认 false（保护页面上已改好的内容）。
 */
export function generateDraft(
  r: ResourceEntry,
  opts: { overwrite?: boolean } = {},
): GeneratedDraft & { existed: boolean; code: string } {
  const code = r.draft_code?.trim() || draftCodeFor(r);
  const file = path.join(DRAFTS_DIR, `${code}.json`);
  const existed = fs.existsSync(file);
  if (existed && !opts.overwrite) {
    return { file, draft: JSON.parse(fs.readFileSync(file, 'utf8')), existed: true, code };
  }

  const cfg = VERIFIED_PUBLISH_CONFIG;
  const draft = {
    code,
    sourcePath: `百度：${r.baidu.root || '—'}\n夸克：${r.quark.root || '—'}`,
    item_biz_type: cfg.item_biz_type,
    sp_biz_type: cfg.sp_biz_type,
    channel_cat_id: cfg.channel_cat_id,
    channel_pv: [],
    // 定价优先级：资源条目自带价 → 类别默认价 → 兜底 9.90
    price: r.price_fen && r.price_fen > 0 ? r.price_fen : (defaultPriceFor(r.category) ?? 990),
    stock: 9999,
    stuff_status: 100,
    publish_shop: [
      {
        // 店铺优先级：**资源条目指定** → 类别指定 → 全局已验证默认
        // ⚠️ 这里要的是闲管家的 user_name（如「顺和服饰平价超市」/「xy346883759115」），
        //    不是后台显示的中文店铺名（如「繁梦空间智能玩家L宇」）
        // ⚠️ 资源级覆盖必须最先判断：账号被封/限流时会把个别商品改发别的店，
        //    若不覆盖，下次生成草稿会悄悄退回类别默认店铺。
        user_name: r.shop?.trim() || categoryOf(r.category)?.shop || cfg.user_name,
        province: cfg.province,
        city: cfg.city,
        district: cfg.district,
        title: defaultTitle(r),
        content: defaultContent(r),
        images: r.cover_images?.length
          ? r.cover_images
          : ['https://cdn.goofish.pro/xgj/LAqwnsm3bj/product/2026/10/06/1787601768090821.png'],
      },
    ],
    compliance: {
      clean: false,
      note: '⚠️ 待人工确认：本条目由资源扫描自动生成，版权/授权来源需你确认后再上架',
    },
    _generated: true,
    _resource_id: r.id,
    _generated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    _notes: [
      '本文件由后台管理页从「资源条目」生成，是**初稿**。',
      '· 标题请按闲鱼规则核对：上限 30，且数字与特殊字符各占 2 位',
      '· compliance.clean 必须改成 true 才允许上架（版权确认后）',
      '· 封面图必须是公网 URL，闲鱼侧要能抓到',
      '生成后可用 npm run gf:preview 体检，或在管理页点「待发布」查看阻塞项。',
    ],
  };

  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(draft, null, 2) + '\n');
  return { file, draft, existed, code };
}

/** 读取 drafts/ 下所有草稿（供管理页展示待发布队列） */
export function loadDrafts(): Array<{ file: string; code: string; draft: any }> {
  if (!fs.existsSync(DRAFTS_DIR)) return [];
  return fs
    .readdirSync(DRAFTS_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .sort()
    .map((f) => {
      const file = path.join(DRAFTS_DIR, f);
      try {
        const draft = JSON.parse(fs.readFileSync(file, 'utf8'));
        // 只认「商品草稿」：必须带 publish_shop 数组。
        // drafts/ 目录下还躺着货源清单（goods-bd-to-xy.json）等其它 JSON，
        // 不加这道过滤会被当成缺一堆字段的草稿，在页面上刷出 10 个假阻塞项。
        if (!Array.isArray(draft?.publish_shop)) return null;
        return { file, code: String(draft.code ?? f.replace(/\.json$/, '')), draft };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{ file: string; code: string; draft: any }>;
}

/** 读取上架台账（code → 线上状态） */
export function loadListings(): Record<string, { product_id: number; state: string; title?: string; updated_at: string }> {
  try {
    return JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, '.listings.json'), 'utf8'));
  } catch {
    return {};
  }
}
