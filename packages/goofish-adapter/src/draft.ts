import type { CreateProductReq, ChannelPv } from './types';

/**
 * 商品草稿：介于「网盘资源」与「创建商品请求」之间的中间表示。
 *
 * 设计意图：让 AI 只负责产出**内容**（标题/描述/定价/图片），
 * 类目 ID、属性 ID 这些必须联网查的字段由流程自动补全，
 * 最后由 validateDraft() 做一次阻塞项体检，缺什么一目了然。
 */
export interface ProductDraft {
  /** 草稿标识，同时用作 outer_id */
  code: string;
  /** 对应网盘资源目录（仅记录用途，不参与接口调用） */
  sourcePath: string;

  /** 商品类型 2 = 普通商品 */
  item_biz_type: number;
  /** 行业类型，虚拟资料建议 22（虚拟游戏）或 99（其他），需按类目实际可选值调整 */
  sp_biz_type: number;

  /** 闲鱼类目 ID，留空则由流程查询后回填 */
  channel_cat_id?: string;
  /** 类目属性（必填属性缺失会导致创建失败） */
  channel_pv?: ChannelPv[];

  /** 售价，单位：分 */
  price: number;
  original_price?: number;
  express_fee?: number;
  stock: number;
  stuff_status?: number;

  /** 发布到哪个店铺（user_name = 闲鱼会员名） */
  publish_shop: Array<{
    user_name: string;
    province?: number;
    city?: number;
    district?: number;
    title: string;
    content: string;
    images: string[];
    service_support?: string;
  }>;

  /** 商品标题与描述（单店铺场景的快捷写法，会被合入 publish_shop[0]） */
  title?: string;
  content?: string;
  images?: string[];

  /** 备注：版权/合规判断结论 */
  compliance?: { clean: boolean; note?: string };
}

export interface DraftIssue {
  level: 'blocker' | 'warn' | 'info';
  field: string;
  message: string;
}

/**
 * 体检草稿，列出所有阻塞项。
 * 只做**静态**校验（字段齐全性、取值范围、图片可访问性格式），
 * 类目/属性是否匹配要联网才知道，由 listProperties 那一步负责。
 */
export function validateDraft(d: ProductDraft): DraftIssue[] {
  const out: DraftIssue[] = [];
  const blocker = (field: string, message: string) => out.push({ level: 'blocker', field, message });
  const warn = (field: string, message: string) => out.push({ level: 'warn', field, message });

  if (!d.code) blocker('code', '缺少草稿标识');
  if (!d.item_biz_type) blocker('item_biz_type', '缺少商品类型');
  if (!d.sp_biz_type) blocker('sp_biz_type', '缺少行业类型');
  if (!d.channel_cat_id) blocker('channel_cat_id', '缺少闲鱼类目 ID —— 需先调 productCategoryList 查询');

  if (!Number.isInteger(d.price) || d.price <= 0) {
    blocker('price', '价格必须为正整数（单位：分）。例：9.9 元 → 990');
  }
  if (d.price > 0 && d.price < 100) {
    warn('price', `价格仅 ${d.price} 分（${(d.price / 100).toFixed(2)} 元），注意别少写一个 0`);
  }
  if (!Number.isInteger(d.stock) || d.stock < 0) blocker('stock', '库存必须为非负整数');

  const shops = d.publish_shop ?? [];
  if (!shops.length) blocker('publish_shop', '至少需要一个发布店铺配置（含 user_name）');

  shops.forEach((s, i) => {
    const p = `publish_shop[${i}]`;
    if (!s.user_name) blocker(`${p}.user_name`, '缺少闲鱼会员名（上架目标店铺）');
    if (!s.title) blocker(`${p}.title`, '缺少商品标题');
    if (!s.content) blocker(`${p}.content`, '缺少商品描述');
    if (!s.images?.length) blocker(`${p}.images`, '缺少商品图片');
    else {
      s.images.forEach((u, k) => {
        if (!/^https?:\/\//.test(u)) {
          blocker(`${p}.images[${k}]`, `图片必须是公网 http/https 地址（官方不支持本地路径、不支持图片上传接口）：${u}`);
        }
      });
    }
    ['province', 'city', 'district'].forEach((f) => {
      if (!(s as any)[f]) warn(`${p}.${f}`, `未设置${f}，部分类目必填`);
    });
    if (s.service_support) {
      warn(`${p}.service_support`, '已设置服务标识：若店铺未开通该服务，上架会报「未开通服务或当前品类不支持开通服务」');
    }
  });

  if (d.compliance && !d.compliance.clean) {
    blocker('compliance', `合规未通过：${d.compliance.note ?? '命中禁售特征'} —— 禁止上架`);
  }
  if (d.compliance === undefined) {
    warn('compliance', '未标注版权/合规结论，上架前请人工确认');
  }

  return out;
}

/** 把 title/content/images 的快捷写法合入 publish_shop[0] */
export function normalizeDraft(d: ProductDraft): ProductDraft {
  if (!d.publish_shop?.length) {
    d.publish_shop = [
      {
        user_name: '',
        title: d.title ?? '',
        content: d.content ?? '',
        images: d.images ?? [],
      },
    ];
  }
  const s = d.publish_shop[0];
  if (!s.title && d.title) s.title = d.title;
  if (!s.content && d.content) s.content = d.content;
  if ((!s.images || !s.images.length) && d.images?.length) s.images = d.images;
  return d;
}

/** 草稿 → 创建商品请求体 */
export function toCreateRequest(d: ProductDraft): CreateProductReq {
  const n = normalizeDraft({ ...d });
  return {
    item_biz_type: n.item_biz_type,
    sp_biz_type: n.sp_biz_type,
    channel_cat_id: n.channel_cat_id ?? '',
    channel_pv: n.channel_pv ?? [],
    price: n.price,
    original_price: n.original_price,
    express_fee: n.express_fee ?? 0,
    stock: n.stock,
    stuff_status: n.stuff_status ?? 100,
    outer_id: n.code,
    publish_shop: n.publish_shop.map((s) => ({
      user_name: s.user_name,
      province: s.province ?? 0,
      city: s.city ?? 0,
      district: s.district ?? 0,
      title: s.title,
      content: s.content,
      images: s.images,
      ...(s.service_support ? { service_support: s.service_support } : {}),
    })),
  };
}
