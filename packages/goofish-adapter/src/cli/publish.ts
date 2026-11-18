/**
 * 商品上架 / 维护 CLI（真实写操作）。
 *
 * 用法：
 *   npm run gf:publish -- <草稿名>                      创建 + 上架（默认 dry-run）
 *   npm run gf:publish -- <草稿名> --live               真正执行（还需 .env 的 GOOFISH_LIVE=true）
 *   npm run gf:publish -- <草稿名> --draft-only          只创建商品数据，不上架
 *   npm run gf:publish -- <草稿名> --at "2026-10-09 10:00"   定时上架
 *   npm run gf:publish -- <草稿名> --update              编辑线上商品数据
 *   npm run gf:publish -- <草稿名> --down-shelf          下架
 *   npm run gf:publish -- <草稿名> --sync                拉取线上状态
 *   npm run gf:publish -- <草稿名> --delete              删除线上商品
 *   npm run gf:publish -- <草稿名> --recreate            忽略本地台账，强制重新创建
 *
 * 三道闸门：
 *   1. validateDraft() 有任何 blocker 就拒绝执行
 *   2. GOOFISH_LIVE=true 且加 --live 才允许真实写
 *   3. **本地台账**（drafts/.listings.json）记录 code → product_id ——
 *      已创建过的商品默认走编辑/同步，不会盲目重复创建
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDraft, normalizeDraft, toCreateRequest, type ProductDraft } from '../draft';
import { runListingAction, XgjWriteError, formatSpecifyPublishTime, type ListingAction } from '../listing';
import { describeListingState, listingStateFromRemoteStatus } from '../state';
import { deleteProduct, getProduct } from '../api';
import {
  GOOFISH_APP_KEY,
  GOOFISH_APP_SECRET,
  GOOFISH_APP_NAME,
  GOOFISH_NOTIFY_URL,
  usingErpCredentials,
  getClient,
  isLive,
} from '../config';
import { compactBody } from '../sign';
import { EP } from '../endpoints';
import { GoofishError } from '../client';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DRAFTS_DIR = path.join(ROOT, 'drafts');
const STORE_FILE = path.join(DRAFTS_DIR, '.listings.json');

const line = (s = '') => process.stdout.write(s + '\n');
const b = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

/* ========================================================================
 * 本地台账：code → product_id
 * 作用只有一个但很关键：**避免重复创建**。
 * 闲管家创建商品没有幂等键（biz_order_id 只能保证同一请求不重复），
 * 一旦上架失败后重跑，很容易在线上堆出一串重复商品。
 * ====================================================================== */

interface StoredListing {
  product_id: number;
  state: string;
  title?: string;
  updated_at: string;
}

function loadStore(): Record<string, StoredListing> {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveStore(store: Record<string, StoredListing>): void {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2) + '\n');
}

/* ======================================================================== */

function loadDraft(name: string): { draft: ProductDraft; file: string } {
  const p = path.isAbsolute(name) ? name : path.join(DRAFTS_DIR, name.endsWith('.json') ? name : `${name}.json`);
  if (!fs.existsSync(p)) throw new Error(`草稿不存在：${p}`);
  return { draft: normalizeDraft(JSON.parse(fs.readFileSync(p, 'utf8'))), file: p };
}

function pickAction(flags: Set<string>): ListingAction {
  if (flags.has('--sync')) return 'sync';
  if (flags.has('--down-shelf')) return 'down_shelf';
  if (flags.has('--update')) return 'update';
  if (flags.has('--at')) return 'schedule';
  if (flags.has('--draft-only')) return 'create';
  return 'publish';
}

const ACTION_VERB: Record<ListingAction, string> = {
  create: '创建商品数据（不上架）',
  publish: '创建 + 上架',
  schedule: '创建 + 定时上架',
  update: '编辑线上商品数据',
  down_shelf: '下架商品',
  sync: '查询线上状态',
};

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const nameArg = positional[0];

  // --at 的值单独取（它不是草稿名）
  const atIdx = argv.indexOf('--at');
  const publishAt = atIdx >= 0 ? argv[atIdx + 1] : undefined;

  line('');
  line(b('══════ 闲管家 商品上架 / 维护 ══════'));
  line('');

  if (!nameArg) {
    line(yellow('  用法：npm run gf:publish -- <草稿名> [选项]'));
    line('');
    line('  动作（默认：创建 + 上架）');
    line('    --draft-only            只创建商品数据，不上架');
    line('    --at "YYYY-MM-DD HH:mm" 定时上架（北京时间）');
    line('    --update                编辑线上商品数据');
    line('    --down-shelf            下架');
    line('    --sync                  查询线上状态');
    line('    --delete                删除线上商品');
    line('');
    line('  其他');
    line('    --live                  真正执行（还需 .env 的 GOOFISH_LIVE=true）');
    line('    --recreate              忽略本地台账，强制重新创建');
    line('');
    line(dim(`  草稿目录：${DRAFTS_DIR}`));
    line('');
    process.exit(2);
  }

  const { draft } = loadDraft(nameArg);
  const store = loadStore();
  const recorded = store[draft.code];
  const recreate = flags.has('--recreate');

  // ---------- 凭证 ----------
  if (!GOOFISH_APP_KEY() || !GOOFISH_APP_SECRET()) {
    line('');
    line(red('  ✗ 未配置进销存凭证'));
    line('    .env 需要 GOOFISH_ERP_APP_KEY / GOOFISH_ERP_APP_SECRET');
    line('    获取：闲管家 → 开放平台 → 订购 ERP 专业版/铂金版 → 创建「进销存」应用 → **上线**');
    line('');
    process.exit(2);
  }

  const live = isLive() && flags.has('--live');
  const action = flags.has('--delete') ? 'delete' : pickAction(flags);

  // ---------- 台账提示 ----------
  line(dim(`  草稿    : ${draft.code}`));
  line(dim(`  应用    : ${GOOFISH_APP_NAME() || '(未命名)'}  key=${GOOFISH_APP_KEY().slice(0, 8)}…${GOOFISH_APP_KEY().slice(-4)}`));
  line(dim(`  凭证来源: ${usingErpCredentials() ? 'GOOFISH_ERP_APP_*（进销存专用）' : '\x1b[33mGOOFISH_APP_*（回落到旧变量，请确认这是进销存应用）\x1b[0m'}`));
  if (recorded && action !== 'delete') {
    line(
      `  台账    : 已记录 product_id=${recorded.product_id} ` +
        `(${describeListingState(listingStateFromRemoteStatus(recorded.state))}, ${recorded.updated_at})` +
        (recreate ? yellow('  ← --recreate 将忽略它并新建') : ''),
    );
  } else if (action !== 'delete' && action !== 'sync' && action !== 'down_shelf') {
    line(`  台账    : ${dim('无记录，将新建商品')}`);
  }
  line('');

  // ---------- 写动作先做草稿体检 ----------
  const needsDraft = action !== 'delete' && action !== 'sync' && action !== 'down_shelf';
  if (needsDraft) {
    const issues = validateDraft(draft);
    const blockers = issues.filter((i) => i.level === 'blocker');
    if (blockers.length) {
      line(red('  ✗ 草稿存在阻塞项，拒绝执行：'));
      for (const i of blockers) line(`      [${i.field}] ${i.message}`);
      line('');
      line(dim('  先跑 `npm run gf:preview` 看完整清单。'));
      line('');
      process.exit(1);
    }
    line(green('  ✅ 草稿体检通过'));
  }

  /* ==================== 删除 ==================== */
  if (action === 'delete') {
    const pid = Number(process.env.GOOFISH_PRODUCT_ID ?? recorded?.product_id ?? 0);
    if (!pid) {
      line(red('  ✗ 需要 product_id：设环境变量 GOOFISH_PRODUCT_ID=<id> 或先执行过一次创建'));
      process.exit(2);
    }
    if (!live) {
      line(yellow(`  [dry-run] 将删除 product_id=${pid}`));
      line(dim('    加 --live 且 GOOFISH_LIVE=true 才真删，且此操作不可逆。'));
      line('');
      process.exit(0);
    }
    try {
      await deleteProduct(pid);
    } catch (e: any) {
      // 实测：在架商品不允许直接删除，必须先下架（闲管家返回 code=100001「在架商品不允许删除」）
      if (/在架商品不允许删除|不允许删除/.test(String(e?.message ?? ''))) {
        line('');
        line(red('  ✗ 商品还在架上，闲管家不允许直接删除'));
        line(yellow('     要先下架，再删除：'));
        line(`       GOOFISH_LIVE=true npm run gf:publish -- ${nameArg} --down-shelf --live`);
        line(`       GOOFISH_PRODUCT_ID=${pid} GOOFISH_LIVE=true npm run gf:publish -- ${nameArg} --delete --live`);
        line('');
        process.exit(1);
      }
      throw e;
    }
    if (recorded?.product_id === pid) {
      delete store[draft.code];
      saveStore(store);
      line(dim('  （已从本地台账移除该 code）'));
    }
    line(green(`  ✅ 已删除 product_id=${pid}`));
    line('');
    return;
  }

  /* ==================== dry-run ==================== */
  if (!live) {
    line('');
    line(yellow(`  ⚠️ dry-run（未设置 GOOFISH_LIVE=true 或未加 --live），不会真的调用接口。`));
    line('');
    line(b(`  动作：${ACTION_VERB[action]}`));

    const client = getClient();
    if (needsDraft) {
      const body = toCreateRequest(draft) as unknown as Record<string, unknown>;
      const createPath = recorded && !recreate ? EP.productEdit : EP.productCreate;
      const built = client.buildRequest(
        createPath,
        recorded && !recreate ? ({ product_id: recorded.product_id, ...body } as Record<string, unknown>) : body,
      );
      line('');
      line(dim(`  —— ${createPath.endsWith('edit') ? '编辑' : '创建'}商品 ——`));
      line(`    POST ${built.url.replace(GOOFISH_APP_KEY(), GOOFISH_APP_KEY().slice(0, 8) + '…')}`);
      line(`    body: ${built.body}`);
    }
    if (action === 'publish' || action === 'schedule') {
      const publishBody: Record<string, unknown> = {
        product_id: recorded?.product_id ?? '<上一步返回的 product_id>',
        user_name: draft.publish_shop.map((s) => s.user_name),
      };
      if (GOOFISH_NOTIFY_URL()) publishBody.notify_url = GOOFISH_NOTIFY_URL();
      if (action === 'schedule') {
        try {
          publishBody.specify_publish_time = formatSpecifyPublishTime(publishAt);
        } catch (e) {
          publishBody.specify_publish_time = `<${(e as Error).message}>`;
        }
      }
      line('');
      line(dim(`  —— ${action === 'schedule' ? '定时上架' : '上架'}商品 ——`));
      line(`    POST ${client.domain}${EP.productPublish}?appid=…&timestamp=…&sign=…`);
      line(`    body: ${compactBody(publishBody)}`);
      if (!GOOFISH_NOTIFY_URL()) {
        line('');
        line(yellow('    ⚠️ 未配置 GOOFISH_NOTIFY_URL。官方明确「上架存在发布失败的可能」，'));
        line(yellow('       不填回调地址就无法自动得知失败原因，只能去闲管家后台看「失败原因」列。'));
      }
    }
    if (action === 'down_shelf') {
      line('');
      line(dim('  —— 下架商品 ——'));
      line(`    POST ${client.domain}${EP.productDownShelf}?appid=…&timestamp=…&sign=…`);
      line(`    body: ${compactBody({ product_id: recorded?.product_id ?? '<product_id>', user_name: draft.publish_shop?.map((s) => s.user_name) })}`);
    }
    if (action === 'sync') {
      line('');
      line(dim('  —— 查询商品详情 ——'));
      line(`    POST ${client.domain}${EP.productDetail}?appid=…&timestamp=…&sign=…`);
      line(`    body: ${compactBody({ product_id: recorded?.product_id ?? '<product_id>' })}`);
    }
    line('');
    line(dim('  真正执行：设置 .env 的 GOOFISH_LIVE=true，并加 --live'));
    line('');
    process.exit(0);
  }

  /* ==================== 真实执行 ==================== */
  const productId = recreate ? null : (recorded?.product_id ?? null);

  try {
    const out = await runListingAction(action, {
      draft,
      productId,
      notifyUrl: GOOFISH_NOTIFY_URL() || undefined,
      publishAt,
    });

    if (out.productId) {
      store[draft.code] = {
        product_id: out.productId,
        state: out.state,
        title: draft.publish_shop?.[0]?.title,
        updated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      };
      saveStore(store);
    }

    line('');
    line(green(`  ✅ ${ACTION_VERB[action]} —— 完成`));
    if (out.productId) line(`     product_id : ${out.productId}`);
    line(`     线上状态   : ${describeListingState(out.state)}`);
    for (const n of out.notes) line(yellow(`     · ${n}`));

    if (action === 'publish' || action === 'schedule') {
      line('');
      line(dim('  上架是**异步**的：接口受理 ≠ 已上架。稍后用下面的命令核对真实状态：'));
      line(`    npm run gf:publish -- ${nameArg} --sync --live`);
    }
    line('');
    line(dim(`  （台账已更新：${path.relative(ROOT, STORE_FILE)}）`));
    line('');
  } catch (e) {
    if (e instanceof XgjWriteError) {
      line('');
      line(red(`  ✗ ${e.message}`));
      line(dim(`     错误码：${e.code}`));
      if (e.productId) {
        // 关键分支：商品已经在线上了，落盘并提示「重试上架」而不是重建
        store[draft.code] = {
          product_id: e.productId,
          state: 'draft',
          title: draft.publish_shop?.[0]?.title,
          updated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
        };
        saveStore(store);
        line('');
        line(yellow(`  ⚠️ 线上已存在商品 product_id=${e.productId}（状态：草稿/未上架）`));
        line('     已写入本地台账，**请不要重新创建**。');

        const upstream = e.cause instanceof GoofishError ? e.cause.message : '';
        if (/只能发布\d*个?闲鱼店铺/.test(upstream)) {
          line('');
          line(yellow('  ⚠️ 这个商品已经绑定过一家闲鱼店铺，改绑被拒。'));
          line('     `product/edit` 对 publish_shop 是**追加**语义，改不掉已有店铺，');
          line('     所以换店铺 / 换类目**只能新建商品**：');
          line(`       GOOFISH_LIVE=true npm run gf:publish -- ${nameArg} --recreate --live`);
        } else {
          line('     上架失败常见原因：');
          line('       · 店铺未开通该品类 / 未完成店铺授权');
          line('       · 类目限制（虚拟商品类目未开放）');
          line('       · 图片 URL 不可访问（闲鱼侧要能抓到图）');
          line('');
          line('     修正后重试上架：');
          line(`       GOOFISH_LIVE=true npm run gf:publish -- ${nameArg} --sync --live     # 先确认状态`);
          line(`       GOOFISH_LIVE=true npm run gf:publish -- ${nameArg} --live           # 再重试上架`);
        }
      }
      if (e.cause instanceof GoofishError) {
        line('');
        line(dim(`     上游返回：${e.cause.message}`));
      }
      line('');
      process.exit(1);
    }
    if (e instanceof GoofishError) {
      line('');
      line(red(`  ✗ ${e.message}`));
      line(dim('     常见原因：channel_cat_id 与 sp_biz_type 不匹配 / 缺必填属性 / 图片链接不可访问'));
      line(dim('     排查：npm run gf:categories -- <item_biz_type> <sp_biz_type> <catId>'));
      line('');
      process.exit(1);
    }
    throw e;
  }

  // 收尾核对
  if (action === 'create' || action === 'update') {
    line(b('  当前商品详情（核对用）'));
    try {
      const pid = store[draft.code]?.product_id;
      if (pid) {
        const d = await getProduct(pid);
        line(`     ${JSON.stringify(d).slice(0, 400)}`);
      }
    } catch {
      line(dim('    （详情查询失败，可稍后在闲管家后台查看）'));
    }
    line('');
    line(b('  下一步'));
    line(`    GOOFISH_LIVE=true npm run gf:publish -- ${nameArg} --live        # 上架`);
    line('');
  }
}

main().catch((e) => {
  line('');
  line(red(`  ✗ ${e.message}`));
  line('');
  process.exit(1);
});
