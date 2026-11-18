/**
 * 商品标题 / 描述的关键词库 —— 目标是**提高闲鱼站内搜索曝光**。
 *
 * 为什么单独成文件：标题与描述是「能被搜到」的唯一入口，规则要在所有类别、
 * 所有生成路径（网页生成、脚本批量生成）里一致，不能各写一份。
 * `publish-draft.ts` 的 defaultTitle / defaultContent 都从这里取词。
 *
 * ⚠️ 两条硬约束
 *
 * 1. **闲鱼标题上限 30 权重**：汉字/字母 = 1，数字与特殊字符各 = 2。
 *    空格也算特殊字符（=2），所以空格很贵 —— 只在必要处用。
 *
 * 2. **不用违规 / 限流词**。项目已确认的雷区：破解、免费、永久、全网最低、
 *    可商用。另外「一键安装」这类描述事实的短句可以用，但不能编造
 *    （例如「含教程」「汉化版」只有在确实提供时才可写）。
 */

export interface KeywordBank {
  /** 品类词：买家搜「3D模型」这类词时最先命中 */
  category: string[];
  /** 单个名词，用来和平台名拼成真正的搜索词（如 Blender+模型 → 「Blender模型」） */
  noun: string;
  /** 使用场景 / 用途词：长尾流量的主要来源 */
  usage: string[];
  /** 属性词：修饰转化，不承担主流量 */
  attr: string[];
}

/** 平台识别顺序 = 展示优先级 */
export const PLATFORM_RULES: Array<{ key: string; label: string; re: RegExp }> = [
  { key: 'blender', label: 'Blender', re: /blender|\bblend\b/i },
  { key: '3dsmax', label: '3DMAX', re: /3ds\s*max|3dsmax|3d\s*max/i },
  { key: 'zbrush', label: 'ZBrush', re: /zbrush/i },
  { key: 'maya', label: 'Maya', re: /maya/i },
  { key: 'c4d', label: 'C4D', re: /cinema\s*4d|\bc4d\b/i },
  { key: 'unreal', label: 'UE5', re: /unreal|\bue\s*[45]\b/i },
  { key: 'substance', label: 'Substance', re: /substance/i },
  { key: 'md', label: 'Marvelous', re: /marvelous|\bclo\s*3d\b|clo3d|\bzprj\b/i },
];

export const KEYWORD_BANKS: Record<string, KeywordBank> = {
  '3d-model': {
    category: ['3D模型', '模型素材', '3D素材', '三维模型', '建模素材', 'CG素材', '3D资源'],
    noun: '模型',
    usage: [
      '游戏建模', '角色模型', '场景模型', '影视素材', '动画素材',
      '渲染素材', '次世代模型', '参考素材', 'AI绘画参考', '设计参考',
    ],
    attr: ['高精度', '写实', '全格式', '含贴图', '带材质', '拓扑干净', '多软件可用'],
  },
  'blender-asset': {
    category: ['Blender资产', 'Blender素材', '3D资产', '模型素材', 'Blender资源'],
    noun: '资产',
    usage: ['建模素材', '场景搭建', '材质贴图', '渲染素材', '游戏建模', '设计参考'],
    attr: ['高精度', '写实', '全格式', '含贴图', '带材质'],
  },
  'blender-plugin': {
    category: ['Blender插件', 'Blender扩展', '建模插件', 'Blender工具', '效率插件', 'Blender脚本'],
    noun: '插件',
    usage: [
      '三维建模', '建模辅助', '工作效率', '渲染辅助', '材质制作',
      '节点工具', '动画插件', '场景搭建', 'Blender教程',
    ],
    attr: ['一键安装', '最新版', '插件合集'],
  },
  'design-asset': {
    category: ['设计素材', '笔刷素材', '素材包', '设计资源'],
    noun: '素材',
    usage: ['平面设计', '插画参考', 'PS笔刷', 'Procreate笔刷', '设计参考'],
    attr: ['高精度', '分类清晰'],
  },
  'design-software': {
    category: ['设计软件', '设计工具', '电脑软件'],
    noun: '软件',
    usage: ['平面设计', 'UI设计', '设计工具', '设计入门'],
    attr: ['一键安装'],
  },
  // 通用软件 / 应用。
  // ⚠️ 2026-10-15 修：这里原来是「车机软件 / 车机投屏 / 安卓应用」—— 那是给
  //    DiPlay（车机投屏 App）写的，后来被套用到 ArtCraft 这批**桌面创作软件**上，
  //    拼出「开源照片编辑器 车机软件 官方原版」这种**描述与实物不符**的标题
  //    （发出去必被买家投诉 / 平台判违规）。改成中性词；
  //    车机、移动端这类特殊资源建议在草稿里**手写标题**。
  software: {
    category: ['电脑软件', '应用软件', '软件工具', '装机必备'],
    noun: '软件',
    usage: ['电脑软件', '办公软件', '设计工具', '效率工具'],
    attr: ['官方原版', '含安装说明'],
  },
};

/**
 * 从标题里抽出「核心名」—— 中文为主的短名，丢掉来源站后缀与一长串英文。
 *
 * 为什么必须抽：闲鱼标题只有 30 权重，而采集来的标题形如
 *   「蝴蝶3D模型 Butterfly Realistic 3D Model Pack」
 * 后半段英文既占权重、又几乎不带中文搜索流量。抽掉它才能腾出位置放真正的热搜词。
 */
const KEEP_LATIN = new Set([
  '3d', '2d', '3ds', 'max', 'fbx', 'obj', 'c4d', 'ue5', 'ue4', 'stl', 'glb', 'gltf',
  'hdri', 'pbr', '4k', '8k', '2k', 'ai', 'cg', 'md', 'zprj', 'abc', 'usd', 'dae', 'blend',
  // ⚠️ 2026-10-15：**品牌名必须保留**。coreName 会把「不认识的英文 token」丢掉，
  //    结果 `ArtCraft 开源创作套件` 被抽成 `开源创作套件` —— 买家搜品牌名搜不到。
  'artcraft', 'photocraft', 'pdfcraft', 'lightcraft', 'wordcraft', 'vectorcraft',
  'effectcraft', 'cadcraft', 'designcraft', 'deckcraft', 'soundcraft', 'figcraft',
  'craft', 'launcher',
]);

export function coreName(title: string): string {
  let s = String(title || '').trim();
  // 去掉括号补充说明
  s = s.replace(/\s*[（(][^）)]*[）)]\s*/g, ' ').trim();
  const tokens = s.split(/\s+/).filter(Boolean);

  const isKeep = (t: string) => {
    const bare = t.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    if (KEEP_LATIN.has(bare)) return true;
    // 整个 token 恰好就是一个软件名（不含 + 之类的拼接）才保留
    return PLATFORM_RULES.some((p) => p.re.test(t)) && !/[+&/]/.test(t);
  };

  const firstCJK = tokens.findIndex((t) => /[\u4e00-\u9fa5]/.test(t));
  // 首个中文词之前的英文 token：只保留真正有意义的（3DS / Blender …）。
  // ⚠️ 早前是「遇到不认识的英文词就 break」，结果
  //    「3DS MAX+Blender+Substance Painter 48组8K石头材质预设」
  //    整条中文核心名被吞掉，标题只剩一串软件名。
  const lead: string[] = firstCJK > 0 ? tokens.slice(0, firstCJK).filter(isKeep) : [];

  const body: string[] = [];
  for (const t of tokens.slice(Math.max(firstCJK, 0))) {
    if (/[\u4e00-\u9fa5]/.test(t) || isKeep(t)) body.push(t);
    else break;
  }

  let core = [...lead, ...body].join(' ').trim().replace(/[|\-–—:：,，]+$/, '').trim();
  // 核心名以 Blender 开头时后续会用平台词补，这里先去掉避免「BlenderBlender插件」
  core = core.replace(/^Blender\s*/i, '').trim();
  if (!core) core = String(title || '').trim().slice(0, 12);
  return core;
}

/** 闲鱼标题权重：汉字/字母 = 1，数字与特殊字符各 = 2 */
export function titleWeight(s: string): number {
  let w = 0;
  for (const ch of s) w += /[0-9]/.test(ch) || !/[\u4e00-\u9fa5a-zA-Z]/.test(ch) ? 2 : 1;
  return w;
}

/** 按权重截断标题，避免超出闲鱼 30 的上限（截断处不留半个词） */
export function clampTitle(s: string, max = 30): string {
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = /[0-9]/.test(ch) || !/[\u4e00-\u9fa5a-zA-Z]/.test(ch) ? 2 : 1;
    if (w + cw > max) break;
    out += ch;
    w += cw;
  }
  return out.trim();
}

/** 逐段拼装，超出 30 权重的段直接丢掉（而不是截断出半个词） */
function fill(parts: string[], max = 30): string {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    const candidate = out ? `${out} ${p}` : p;
    if (titleWeight(candidate) <= max) out = candidate;
  }
  return out;
}

/** 识别适用的软件（标题优先，正文兜底），最多 2 个 —— 标题里塞太多反而挤掉品类词 */
export function detectPlatforms(r: any): string[] {
  // 导入时若已探测过（来自文章正文），直接用，避免在标题文案上漏掉平台词
  const preset: string[] = Array.isArray(r?.platforms) ? r.platforms : [];
  const title = String(r?.title ?? r?.display_name ?? r?.name ?? '');
  const body = [
    ...preset,
    String(r?.detailText ?? ''),
    ...((r?.baidu as any)?.folders ?? []),
    ...((r?.down_links as any) ?? []).map((d: any) => d?.label),
  ].filter(Boolean).join(' ');
  const hits: Array<{ label: string; score: number }> = [];
  PLATFORM_RULES.forEach((p, idx) => {
    const score = p.re.test(title) ? 3 : p.re.test(body) ? 1 : 0;
    if (score) hits.push({ label: p.label, score: score * 10 - idx });
  });
  const ordered = hits.sort((a, b) => b.score - a.score).map((h) => h.label);
  return [...new Set([...preset, ...ordered])].slice(0, 2);
}

/**
 * 挑一个「还没在核心名里出现过」的品类词，并视情况补平台前缀。
 *
 * 两个坑都踩过：
 *   · 核心名已含「3D模型」时再加一次 → 「蝴蝶3D模型 3D模型 …」重复
 *   · 「Blender插件」前面又拼一次 Blender → 「BlenderBlender插件」
 */
function pickCat(bank: KeywordBank, core: string, plat: string): string {
  const usable = bank.category.filter((c) => !core.includes(c));
  // 要拼平台前缀时，避开以数字开头的品类词 —— 否则会拼出「ZBrush3D模型」这种生造词
  const pick =
    (plat ? usable.find((c) => !/^[0-9]/.test(c)) : undefined) ?? usable[0] ?? '';
  if (!pick) return '';
  const alreadyHasPlat = !!plat && pick.toLowerCase().startsWith(plat.toLowerCase());
  return alreadyHasPlat || !plat ? pick : `${plat}${pick}`;
}

/**
 * 生成商品标题 —— 结构：`核心名 · 平台+品类 · 用途/属性`
 *
 * 例：`蝴蝶3D模型 模型素材 高精度写实游戏建模`
 */
export function buildTitle(r: any, opts: { max?: number } = {}): string {
  const max = opts.max ?? 30;
  const bank = KEYWORD_BANKS[r?.category ?? ''] ?? KEYWORD_BANKS['3d-model'];
  const core = coreName(r?.display_name || r?.name || r?.title || '');
  const platforms = detectPlatforms(r);
  const plat = platforms[0] ?? '';

  const platCat = pickCat(bank, core, plat);
  let out = fill([core, platCat], max) || core.slice(0, 15);

  // 尾部（用途 / 属性词）自适应：从最长的候选往下试，挑**塞得下的最长那个**。
  // 早前是直接拼三段，塞不下就整段丢掉，白白浪费 5~10 个权重的曝光位。
  const [a0, a1] = bank.attr;
  const u0 = bank.usage[0];
  const tails = [
    [a0, a1, u0].filter(Boolean).join(''),
    [a0, a1].filter(Boolean).join(''),
    [a0, u0].filter(Boolean).join(''),
    a0, u0,
  ].filter(Boolean) as string[];
  for (const t of tails) {
    if (titleWeight(`${out} ${t}`) <= max) { out = `${out} ${t}`; break; }
  }
  return out;
}

/**
 * 描述末尾的「相关搜索」词块。
 *
 * ⚠️ 用逗号分隔而不是堆成一串 —— 既好读，也能让闲鱼的文本索引切出更多词。
 * 这里只是**补充**，主体仍是「包含内容 / 获取方式 / 使用说明」，
 * 全篇关键词堆砌反而会被判低质。
 */
export function keywordLine(r: any): string {
  const bank = KEYWORD_BANKS[r?.category ?? ''] ?? KEYWORD_BANKS['3d-model'];
  const platforms = detectPlatforms(r);
  const words = [
    // 平台 × 品类名词 的交叉词 —— 这才是真实搜索习惯：「Blender模型」「ZBrush插件」
    ...platforms.map((p) => `${p}${bank.noun}`),
    ...bank.category,
    ...platforms,
    ...bank.usage,
    ...bank.attr.slice(0, 2),
  ];
  const uniq: string[] = [];
  for (const w of words) if (w && !uniq.includes(w) && uniq.length < 16) uniq.push(w);
  return ['■ 相关搜索', uniq.join('、')].join('\n');
}
