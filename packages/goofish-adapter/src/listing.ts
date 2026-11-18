/**
 * 上架流程编排层。
 *
 * 把「创建 / 编辑 → 创建→上架 / 定时上架 / 下架 / 同步」收敛成一次调用，
 * 并负责两件 `api.ts` 不该管的事：
 *
 *   1. **写前守卫** —— 类目、图片、会员名、回调地址在发请求前就校验掉，
 *      错误发生在本地而不是线上。线上失败会留下垃圾数据，本地失败只是重跑一次。
 *
 *   2. **失败语义分离** —— 区分两种失败：
 *        · 创建阶段失败     → 线上没产生任何资产，重跑整条流程即可
 *        · 已创建但上架失败 → ⚠️ 线上已留下一个草稿商品，**必须重试上架而不是重新创建**
 *      第二种是最容易踩的坑：不加区分地重跑，会不停堆积重复商品，
 *      而每个重复品都带着同一个 outer_id，事后清理很麻烦。
 *
 * 参考了同类实现的做法（把「已保存但未上架」显式建模为一个错误码），
 * 本项目对应 `XGJ_PUBLISH_FAILED`，并带上 productId 供上层落盘重试。
 */
import { createProduct, editProduct, publishProduct, downShelfProduct, getProduct } from './api';
import { toCreateRequest, type ProductDraft } from './draft';
import { listingStateFromRemoteStatus, type RemoteListingState } from './state';

export type ListingAction = 'create' | 'publish' | 'schedule' | 'update' | 'down_shelf' | 'sync';

export class XgjWriteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** 失败时若线上已有商品，带上它的 ID，供上层落盘重试 */
    readonly productId: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'XgjWriteError';
  }
}

export interface ListingInput {
  draft: ProductDraft;
  /** 已存在的闲管家商品 ID：有值走 edit，无值走 create */
  productId?: number | null;
  /** 上架回调地址。缺失不阻塞（本项目回调地址尚未固定），但会记入 note */
  notifyUrl?: string;
  /** 定时上架时间，接受 ISO 或 "YYYY-MM-DD HH:mm[:ss]"（按本机时区解释） */
  publishAt?: string;
}

export interface ListingOutcome {
  action: ListingAction;
  productId: number | null;
  state: RemoteListingState;
  /** 值得提醒但不阻塞的事实，例如「未配置回调地址」 */
  notes: string[];
}

/* ========================================================================
 * 守卫
 * ====================================================================== */

const isPublicUrl = (u: string) => /^https?:\/\/\S+$/i.test(u);

/** 写操作前的静态校验。任何一条不过就直接拒绝，不给「先发出去再说」的机会。 */
export function assertDraftWritable(draft: ProductDraft): void {
  if (!draft.channel_cat_id?.trim()) {
    throw new XgjWriteError(
      'XGJ_CATEGORY_REQUIRED',
      '缺少闲鱼类目 ID（channel_cat_id）—— 先跑 `npm run gf:categories` 查询后回填草稿',
    );
  }

  const shops = draft.publish_shop ?? [];
  if (!shops.length) {
    throw new XgjWriteError('XGJ_SHOP_REQUIRED', '缺少 publish_shop 配置，至少要有一个发布店铺');
  }

  shops.forEach((s, i) => {
    const p = `publish_shop[${i}]`;
    if (!s.user_name?.trim()) {
      throw new XgjWriteError(
        'XGJ_SHOP_USERNAME_REQUIRED',
        `${p}.user_name 为空 —— 这里要填**闲鱼会员名**（形如 xy1234567890），不是店铺昵称`,
      );
    }
    if (!s.title?.trim()) throw new XgjWriteError('XGJ_TITLE_REQUIRED', `${p}.title 为空`);
    if (!s.content?.trim()) throw new XgjWriteError('XGJ_CONTENT_REQUIRED', `${p}.content 为空`);
    if (!s.images?.length) {
      throw new XgjWriteError(
        'XGJ_IMAGE_REQUIRED',
        `${p}.images 至少需要 1 张图 —— 官方没有图片上传接口，必须是公网可访问的 URL`,
      );
    }
    s.images.forEach((u, k) => {
      if (!isPublicUrl(u)) {
        throw new XgjWriteError(
          'XGJ_IMAGE_NOT_PUBLIC',
          `${p}.images[${k}] 不是公网 http/https 地址（不支持本地路径）：${u}`,
        );
      }
    });
  });
}

/** 校验回调地址格式。仅在**提供了值**时校验；缺失由上层决定是否容忍。 */
export function assertNotifyUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new XgjWriteError('XGJ_NOTIFY_URL_INVALID', `回调地址格式无效：${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new XgjWriteError('XGJ_NOTIFY_URL_INVALID', `回调地址必须是 http/https：${url}`);
  }
  return parsed.toString();
}

/**
 * 定时上架时间 → 闲管家要求的北京时间字符串 `YYYY-MM-DD HH:mm:ss`。
 *
 * ⚠️ 这里是**最容易错的一处**：官方要的是北京时间的「墙上时间」字符串。
 * 做法是把时间戳平移到 UTC+8 后再取 ISO 表示并截断 —— 不能直接用
 * `toLocaleString()`（受运行环境 locale 影响），也不能用裸 `toISOString()`
 * （那是 UTC，会比北京时间少 8 小时，商品会在错误的时间上架）。
 */
export function formatSpecifyPublishTime(input: string | undefined, now: number = Date.now()): string {
  if (!input) {
    throw new XgjWriteError('XGJ_PUBLISH_TIME_REQUIRED', '定时上架需要指定时间，例：--at "2026-10-09 10:00"');
  }
  const ts = Date.parse(input);
  if (!Number.isFinite(ts)) {
    throw new XgjWriteError(
      'XGJ_PUBLISH_TIME_INVALID',
      `定时上架时间无法解析：${input}（建议写成 "YYYY-MM-DD HH:mm" 或带时区的 ISO）`,
    );
  }
  if (ts <= now) {
    throw new XgjWriteError('XGJ_PUBLISH_TIME_PAST', `定时上架时间已过去：${input} —— 该用 --publish 立即上架`);
  }
  return new Date(ts + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}

/* ========================================================================
 * 编排
 * ====================================================================== */

export async function runListingAction(action: ListingAction, input: ListingInput): Promise<ListingOutcome> {
  const { draft } = input;
  const existing = input.productId ?? null;
  const notes: string[] = [];
  if (!existing) notes.push('本地未记录 product_id，将走**创建**分支');

  /* ---------- 只读动作 ---------- */
  if (action === 'sync') {
    if (!existing) {
      throw new XgjWriteError('XGJ_PRODUCT_ID_REQUIRED', '同步线上状态需要 ProductDraft.code 对应的 product_id，请先执行创建');
    }
    const detail = await getProduct(existing);
    return {
      action,
      productId: existing,
      state: listingStateFromRemoteStatus(detail.product_status),
      notes,
    };
  }

  if (action === 'down_shelf') {
    if (!existing) {
      throw new XgjWriteError('XGJ_PRODUCT_ID_REQUIRED', '下架需要 product_id，请先执行创建或同步');
    }
    await downShelfProduct({
      product_id: existing,
      user_name: draft.publish_shop?.map((s) => s.user_name),
    });
    return { action, productId: existing, state: 'down_shelved', notes };
  }

  /* ---------- 写动作 ---------- */
  assertDraftWritable(draft);

  const needsPublish = action === 'publish' || action === 'schedule';
  const notifyUrl = needsPublish ? assertNotifyUrl(input.notifyUrl) : undefined;
  if (needsPublish && !notifyUrl) {
    notes.push('未配置回调地址 notify_url —— 上架失败时无法自动获知原因，只能去闲管家后台看「失败原因」列');
  }
  const publishAt = action === 'schedule' ? formatSpecifyPublishTime(input.publishAt) : undefined;

  if (action === 'update' && !existing) {
    throw new XgjWriteError('XGJ_PRODUCT_ID_REQUIRED', '编辑线上商品需要 product_id，请先执行创建或同步');
  }

  /* ----- 阶段 1：创建 / 编辑商品数据 ----- */
  // create 分支失败时线上不留任何东西，直接抛出，让调用方放心重跑
  //
  // ⚠️⚠️ 2026-10-07 实测：`product/edit` 对 `publish_shop` 是**追加**语义，不是替换。
  // 对同一 product_id 用不同店铺 edit 一次，detail 里就会出现两条 publish_shop 记录，
  // 随后 publish 会被拒绝：「每个商品只能发布1个闲鱼店铺」。
  // → **换店铺/换类目必须新建商品（--recreate），不能靠 edit 改。**
  const req = toCreateRequest(draft);
  let productId: number;
  try {
    const resp = existing ? await editProduct({ product_id: existing, ...req }) : await createProduct(req);
    productId = existing ?? Number((resp as { product_id?: number }).product_id);
  } catch (cause) {
    throw new XgjWriteError(
      'XGJ_CREATE_FAILED',
      existing ? '编辑商品数据失败（线上商品未被改动）' : '创建商品失败（线上未产生任何商品，可安全重跑）',
      null,
      { cause },
    );
  }
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    throw new XgjWriteError(
      'XGJ_CREATE_RESPONSE_INVALID',
      '创建接口返回成功，但没有给出有效的 product_id —— 请去闲管家后台确认是否已产生商品',
    );
  }

  if (!needsPublish) {
    return {
      action,
      productId,
      state: action === 'create' ? 'draft' : 'unknown',
      notes,
    };
  }

  /* ----- 阶段 2：上架 ----- */
  // ⚠️ 到这里线上**已经有一个商品**。上架失败绝不能当作「整条流程失败」，
  //    否则重跑会再创建一个，越积越多。
  try {
    await publishProduct({
      product_id: productId,
      user_name: draft.publish_shop.map((s) => s.user_name),
      ...(notifyUrl ? { notify_url: notifyUrl } : {}),
      ...(publishAt ? { specify_publish_time: publishAt } : {}),
    });
  } catch (cause) {
    throw new XgjWriteError(
      'XGJ_PUBLISH_FAILED',
      `商品数据已保存，但**未完成上架**。请修正原因后重试上架（不要重新创建）`,
      productId,
      { cause },
    );
  }

  if (publishAt) notes.push(`定时上架时间（北京时间）：${publishAt}`);
  return { action, productId, state: 'pending_review', notes };
}
