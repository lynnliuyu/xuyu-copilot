/**
 * 资源条目 —— 上架流水线的源头。
 *
 * 一条资源 = 一份待售的网盘资源集合，同时记录**百度网盘**与**夸克网盘**两侧的状态：
 * 目录位置、对外分享链接 + 提取码、目录下的子项清单。
 *
 * 为什么把两侧塞进同一个条目：
 *   1. 用户要求两侧采用**同样的文件夹命名**，放一起才做得了命名一致性校验；
 *   2. 上架时要决定「用哪一侧的链接发货」，同一条目里对比最直观。
 *
 * 存储：drafts/.resources.json
 *   特意与 goofish-adapter 的草稿（drafts/<code>.json）同目录 —— 网页与命令行
 *   读写同一份数据，不会出现「网页改了、CLI 看不到」的情况。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DRAFTS_DIR = path.join(ROOT, 'drafts');
const RESOURCES_FILE = path.join(DRAFTS_DIR, '.resources.json');

/** 网盘一侧的状态 */
export interface NetdiskSide {
  /** 网盘内的目录路径（百度是绝对路径，夸克是显示路径） */
  root: string;
  /** 夸克侧的目录 FID（百度侧留空） */
  fid?: string;
  /** 对外分享链接 */
  share_url: string;
  /** 提取码 */
  pwd: string;
  /** 分享有效期描述，如「永久」「7天」 */
  expire?: string;
  /** 该目录下的子项名（用于两侧命名一致性校验） */
  folders: string[];
  /** 该侧的文件统计，仅作展示 */
  file_count?: number;
  size_bytes?: number;
  /** 最近一次扫描时间 */
  scanned_at?: string;
}

/* ========================================================================
 * 类别
 * ====================================================================== */

export interface Category {
  id: string;
  name: string;
  /** 该类别下的**默认售价（分）** —— 新建资源选了这个类别就自动带出 */
  price_fen: number;
  /** 前端标签色 */
  color: string;
  /** 说明，给后台页面做提示 */
  hint?: string;
  /**
   * 该类别默认发布到哪个闲鱼店铺。
   * ⚠️ 必须填闲管家的 **`user_name`**，不是后台看到的中文店铺名 ——
   * 接口只认前者，填成显示名会被拒。
   * 留空 = 用 VERIFIED_PUBLISH_CONFIG.user_name（全局默认）。
   */
  shop?: string;
}

/**
 * 已授权的闲鱼店铺。
 *
 * ⚠️ **两套名字容易搞混**：闲管家后台显示的是「店铺名」（`shop_name`），
 * 而开放平台接口要传的是 **`user_name`**。实测两者完全不同：
 *
 *   | 后台显示名 | 接口 user_name |
 *   |---|---|
 *   | 繁梦空间智能玩家L宇 | 顺和服饰平价超市 |
 *   | 繁梦空间L宇 | xy346883759115 |
 *
 * 之前就是因为拿「闲鱼昵称」当 user_name 去猜，才会踩到含糊报错。
 */
export const SHOPS: Array<{ user_name: string; label: string; note?: string }> = [
  { user_name: 'xy346883759115', label: '繁梦空间L宇', note: '素材类主发' },
  { user_name: '顺和服饰平价超市', label: '繁梦空间智能玩家L宇', note: '插件 / 软件类' },
];

export function shopLabel(userName?: string | null): string {
  const s = SHOPS.find((x) => x.user_name === userName);
  return s ? s.label : String(userName ?? '');
}

/**
 * 资源类别 —— 决定默认定价与默认发布店铺。
 *
 * 为什么要按类别定价而不是每条手填：
 *   同类资源的价格应该一致（买家横向比价时，同店同类不同价会显得随意），
 *   而且批量上新时逐条填价容易漏、容易填错。这里定好「这一类卖多少钱」，
 *   新建/换类别时自动带出，再用「按类别改价」一次性统一调整。
 *
 * 店铺分工（用户 2026-10-07 定）：
 *   **素材类**（3D 模型 / Blender 资产 / 设计素材）→ `xy346883759115`（繁梦空间L宇）
 *   **插件与软件类**（Blender 插件 / 设计软件）  → `顺和服饰平价超市`（繁梦空间智能玩家L宇）
 */
export const CATEGORIES: Category[] = [
  // —— 素材类：主发账号 繁梦空间L宇 ——
  { id: '3d-model', name: '3D 模型素材', price_fen: 288, color: '#f472b6', hint: '通用 3D 模型 / 场景 / 扫描素材', shop: 'xy346883759115' },
  { id: 'blender-asset', name: 'Blender 资产', price_fen: 188, color: '#22d3ee', hint: '模型 / 材质 / 预设 / HDRI 等资产包', shop: 'xy346883759115' },
  { id: 'design-asset', name: '设计素材', price_fen: 188, color: '#fbbf24', hint: '笔刷 / 素材包 / 小工具', shop: 'xy346883759115' },
  // —— 插件与软件类：主发账号 繁梦空间智能玩家L宇 ——
  { id: 'blender-plugin', name: 'Blender 插件', price_fen: 188, color: '#34d399', hint: 'Blender 插件 / 扩展 / 工具', shop: '顺和服饰平价超市' },
  { id: 'design-software', name: '设计软件', price_fen: 990, color: '#60a5fa', hint: 'Figma / Photoshop 等桌面软件', shop: '顺和服饰平价超市' },
  // —— 通用软件 / 应用（非设计类）：车机应用、移动端 App、工具软件等 ——
  // 与「设计软件」同店发布，但默认价更低：这类多为小工具，2.88 元更贴近市场价。
  { id: 'software', name: '软件 / 应用', price_fen: 288, color: '#a78bfa', hint: '车机 / 移动端 / 工具类软件与应用', shop: '顺和服饰平价超市' },
  { id: 'uncategorized', name: '未分类', price_fen: 990, color: '#94a3b8', hint: '尚未归类的资源' },
];

export function categoryOf(id?: string | null): Category | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

/** 某类别的默认售价（分）。类别不存在或未指定时返回 undefined（由调用方决定兜底） */
export function defaultPriceFor(id?: string | null): number | undefined {
  return categoryOf(id)?.price_fen;
}

export interface ResourceEntry {
  /** 稳定标识，用作 id 与草稿编码的一部分 */
  id: string;
  /** 资源名（两侧目录同名），如 figma */
  name: string;
  /** 展示名，商品文案里用 */
  display_name: string;
  /** 所属类别 id（见 CATEGORIES），决定默认售价 */
  category?: string;
  baidu: NetdiskSide;
  quark: NetdiskSide;
  /** 商品封面图（**必须是公网 http/https URL**，闲鱼侧要能抓到） */
  cover_images: string[];
  /** 商品图副标题（可选）。留空则从目录名自动推断 */
  card_subtitle?: string;
  /**
   * 适用软件（如 ['Blender','ZBrush']）。
   * 由采集导入时从文章正文探测写入，用于**标题与描述的关键词拼装** ——
   * 不少资源的标题里没有软件名，只有正文里写了，不探测就会漏掉「Blender模型」这类高频搜索词。
   */
  platforms?: string[];
  /** 由本条目生成的发布草稿 code（对应 drafts/<code>.json 的 code 字段） */
  draft_code?: string;
  /**
   * **本条目专用的发布店铺**（闲管家 `user_name`，如 `xy346883759115`）。
   *
   * 优先级最高，覆盖类别默认店铺。什么时候需要它：
   *   · 某个账号被平台封控 / 限流，个别商品要临时改发另一个账号
   *   · 同一类别的资源想分散到不同店铺（避免单店在售数触顶）
   *
   * ⚠️ 不加这个字段的话，临时改过的草稿在下次「生成草稿」时会被
   *    `categoryOf(category).shop` 悄悄覆盖回默认店铺 —— 商品就发到被封的账号上去了。
   */
  shop?: string;
  /** 售价（分）。这里是业务定价，与 cost 区分 */
  price_fen?: number;
  /** 备注：版权/合规结论等 */
  notes?: string;
  created_at: string;
  updated_at: string;
}

export type ResourceStore = Record<string, ResourceEntry>;

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export function emptySide(root = ''): NetdiskSide {
  return { root, share_url: '', pwd: '', folders: [] };
}

export function loadResources(): ResourceStore {
  try {
    return JSON.parse(fs.readFileSync(RESOURCES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 原子写 JSON：先写临时文件再 rename。
 *
 * 为什么需要：这些文件是「整文件读改写」，一旦在写入过程中被 Ctrl+C / 进程被杀，
 * 就会留下**半个 JSON**，下次读取直接抛解析错误，整个管理端起不来。
 * rename 在同一文件系统内是原子的，写坏的概率降为 0。
 *
 * ⚠️ 它**不解决并发写**（两个进程同时读改写仍会互相覆盖）。
 *    现状是单用户本机使用，够用；若将来要多端同时操作，需换成真正的锁或数据库。
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function saveResources(store: ResourceStore): void {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  writeJsonAtomic(RESOURCES_FILE, store);
}

export function upsertResource(entry: ResourceEntry): ResourceEntry {
  const store = loadResources();
  const prev = store[entry.id];
  const merged: ResourceEntry = {
    ...(prev ?? {}),
    ...entry,
    created_at: prev?.created_at ?? entry.created_at ?? now(),
    updated_at: now(),
  };
  store[entry.id] = merged;
  saveResources(store);
  return merged;
}

export function patchResource(id: string, patch: Partial<ResourceEntry>): ResourceEntry | null {
  const store = loadResources();
  const prev = store[id];
  if (!prev) return null;
  const merged: ResourceEntry = { ...prev, ...patch, id, updated_at: now() };
  store[id] = merged;
  saveResources(store);
  return merged;
}

export function removeResource(id: string): boolean {
  const store = loadResources();
  if (!store[id]) return false;
  delete store[id];
  saveResources(store);
  return true;
}

/* ========================================================================
 * 校验
 * ====================================================================== */

export interface NamingCheck {
  onlyBaidu: string[];
  onlyQuark: string[];
  matched: string[];
  consistent: boolean;
}

/**
 * 比对两侧的子项命名是否一致。
 *
 * 只比**名字**，不比顺序 —— 网盘列表顺序不稳定，顺序差异不代表命名不一致。
 */
export function checkNaming(baidu: string[], quark: string[]): NamingCheck {
  const b = new Set(baidu);
  const q = new Set(quark);
  const onlyBaidu = [...b].filter((x) => !q.has(x));
  const onlyQuark = [...q].filter((x) => !b.has(x));
  const matched = [...b].filter((x) => q.has(x));
  return {
    onlyBaidu,
    onlyQuark,
    matched,
    consistent: onlyBaidu.length === 0 && onlyQuark.length === 0 && b.size > 0,
  };
}

export interface ResourceIssue {
  level: 'blocker' | 'warn' | 'info';
  field: string;
  message: string;
}

/** 资源条目是否具备「可生成发布草稿」的条件 */
export function validateResource(r: ResourceEntry): ResourceIssue[] {
  const out: ResourceIssue[] = [];
  const blocker = (field: string, message: string) => out.push({ level: 'blocker', field, message });
  const warn = (field: string, message: string) => out.push({ level: 'warn', field, message });
  const info = (field: string, message: string) => out.push({ level: 'info', field, message });

  if (!r.id) blocker('id', '缺少资源标识');
  if (!r.display_name?.trim()) blocker('display_name', '缺少展示名');

  const b = r.baidu ?? emptySide();
  const q = r.quark ?? emptySide();

  // 发货内容就是网盘分享链接，所以**至少要有其中一侧**（不限定必须是百度 ——
  // 有的资源源站只给夸克，硬性要求百度会把这类商品挡在门外）
  const hasBaidu = !!b.share_url?.trim();
  const hasQuark = !!q.share_url?.trim();

  if (!hasBaidu && !hasQuark) {
    blocker('share_url', '两侧都没有分享链接 —— 发货内容就是它，至少需要百度或夸克其中一个');
  }
  if (hasBaidu && !/^https?:\/\//.test(b.share_url)) {
    blocker('baidu.share_url', `百度分享链接不是 http/https：${b.share_url}`);
  }
  if (hasQuark && !/^https?:\/\//.test(q.share_url)) {
    blocker('quark.share_url', `夸克分享链接不是 http/https：${q.share_url}`);
  }
  if (hasBaidu && !b.pwd?.trim()) warn('baidu.pwd', '填了百度链接但没填提取码，买家可能打不开');
  if (hasQuark && !q.pwd?.trim()) warn('quark.pwd', '填了夸克链接但没填提取码，买家可能打不开');
  if (hasBaidu && !b.root?.trim()) warn('baidu.root', '有百度链接但未记录百度侧目录路径');
  if (hasQuark && !q.root?.trim()) warn('quark.root', '有夸克链接但未记录夸克侧目录路径');

  // 只在**两侧都真的用了**（都记了目录）时才比对命名 —— 否则单侧资源的
  // 「仅夸克有 x」会永远挂着一个没意义的警告
  const bothSides = !!b.root?.trim() && !!q.root?.trim();
  const naming = checkNaming(b.folders ?? [], q.folders ?? []);
  if (bothSides && (b.folders?.length ?? 0) + (q.folders?.length ?? 0) > 0 && !naming.consistent) {
    warn(
      'naming',
      `两侧文件夹命名不一致：仅百度有 [${naming.onlyBaidu.join(', ') || '—'}]，仅夸克有 [${naming.onlyQuark.join(', ') || '—'}]`,
    );
  }

  if (!r.cover_images?.length) {
    warn('cover_images', '没有封面图。闲鱼商品至少需要 1 张公网图片，上架前必须补');
  } else {
    r.cover_images.forEach((u, i) => {
      if (!/^https?:\/\//.test(u)) blocker(`cover_images[${i}]`, `封面图必须是公网 URL：${u}`);
    });
  }

  const cat = categoryOf(r.category);
  if (!cat) {
    info('category', '未选择类别 —— 归类后可按类别统一定价与管理');
  }

  // 店铺覆盖（shop）：只在指定了才检查，且必须是我们已授权的 user_name。
  // 填错的后果很隐蔽 —— 商品会发到不存在的店铺上，或者悄悄退回默认店铺。
  if (r.shop?.trim()) {
    const known = SHOPS.find((s) => s.user_name === r.shop!.trim());
    if (!known) {
      warn(
        'shop',
        `指定的发布店铺「${r.shop}」不在已授权列表里（应为 ${SHOPS.map((s) => s.user_name).join(' / ')}）` +
          ' —— 填错会导致上架失败',
      );
    } else {
      const def = cat?.shop;
      info('shop', `本条目将发布到「${known.label}」(${known.user_name})${def && def !== r.shop.trim() ? `，已覆盖类别默认店铺 ${def}` : ''}`);
    }
  }

  if (!r.price_fen || r.price_fen <= 0) {
    warn('price_fen', `未设置售价，生成草稿时将使用类别默认价 ${((cat?.price_fen ?? 990) / 100).toFixed(2)} 元`);
  } else if (cat && r.price_fen !== cat.price_fen) {
    info('price_fen', `售价 ${(r.price_fen / 100).toFixed(2)} 元与「${cat.name}」默认价 ${(cat.price_fen / 100).toFixed(2)} 元不同`);
  }

  return out;
}
