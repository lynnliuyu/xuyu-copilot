/**
 * 商品草稿预览器 —— 不联网、不发请求，只做三件事：
 *   1. 校验草稿，列出所有阻塞项（缺什么、为什么、怎么补）
 *   2. 把草稿渲染成「创建商品」的真实请求体
 *   3. 打印完整 HTTP 请求（含签名），可复制到 Postman / curl 里直接复现
 *
 * 用法：
 *   npm run gf:preview                     预览 drafts/ 下全部草稿
 *   npm run gf:preview -- <文件名或路径>     预览指定草稿
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDraft, normalizeDraft, toCreateRequest, type ProductDraft } from '../draft';
import { EP, ITEM_BIZ_TYPE, SP_BIZ_TYPE } from '../endpoints';
import { compactBody, md5, genSign } from '../sign';
import { GOOFISH_APP_KEY, GOOFISH_APP_SECRET, GOOFISH_SELLER_ID } from '../config';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DRAFTS_DIR = path.join(ROOT, 'drafts');

const line = (s = '') => process.stdout.write(s + '\n');
const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const yuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`;

function readDrafts(arg?: string): Array<{ file: string; draft: ProductDraft }> {
  const out: Array<{ file: string; draft: ProductDraft }> = [];
  if (arg) {
    const p = path.isAbsolute(arg) ? arg : path.join(DRAFTS_DIR, arg.endsWith('.json') ? arg : `${arg}.json`);
    if (!fs.existsSync(p)) throw new Error(`草稿不存在：${p}`);
    out.push({ file: p, draft: JSON.parse(fs.readFileSync(p, 'utf8')) });
    return out;
  }
  if (!fs.existsSync(DRAFTS_DIR)) return out;
  for (const f of fs.readdirSync(DRAFTS_DIR).filter((f) => f.endsWith('.json')).sort()) {
    const p = path.join(DRAFTS_DIR, f);
    try {
      out.push({ file: p, draft: JSON.parse(fs.readFileSync(p, 'utf8')) });
    } catch (e: any) {
      line(C.red(`  ✗ ${f} 解析失败：${e.message}`));
    }
  }
  return out;
}

function previewOne(file: string, draft: ProductDraft) {
  const rel = path.relative(ROOT, file);
  line('');
  line(C.b(`━━━ ${rel} ━━━`));
  line('');

  // ---------- 基本信息 ----------
  const n = normalizeDraft(JSON.parse(JSON.stringify(draft)) as ProductDraft);
  line(C.b('  基本信息'));
  line(`    标识 code     : ${n.code}`);
  line(`    来源网盘路径  : ${n.sourcePath}`);
  line(
    `    商品类型      : ${n.item_biz_type} (${ITEM_BIZ_TYPE[n.item_biz_type] ?? '未知'})` +
      `  行业类型: ${n.sp_biz_type} (${SP_BIZ_TYPE[n.sp_biz_type] ?? '未知'})`,
  );
  line(`    类目 ID       : ${n.channel_cat_id ?? C.red('（待查询后回填）')}`);
  line(
    `    定价          : ${yuan(n.price)}${n.original_price ? C.dim(`（原价 ${yuan(n.original_price)}）`) : ''}` +
      `  库存: ${n.stock}  成色: ${n.stuff_status ?? 100}`,
  );
  line(`    类目属性      : ${n.channel_pv?.length ?? 0} 项`);
  line('');

  // ---------- 发布店铺 ----------
  line(C.b('  发布店铺'));
  n.publish_shop.forEach((s, i) => {
    line(`    [${i}] ${s.user_name ? C.green(s.user_name) : C.red('（未填闲鱼会员名）')}`);
    line(`        标题 : ${s.title}`);
    line(`        描述 : ${s.content.replace(/\n/g, ' ⏎ ').slice(0, 90)}${s.content.length > 90 ? '…' : ''}`);
    line(`        图片 : ${s.images.length} 张`);
    s.images.forEach((u) => line(`               ${u}`));
    if (s.service_support) line(`        服务标识: ${s.service_support}`);
  });
  line('');

  // ---------- 校验 ----------
  const issues = validateDraft(n);
  const blockers = issues.filter((i) => i.level === 'blocker');
  const warns = issues.filter((i) => i.level === 'warn');

  line(C.b('  体检结果'));
  if (!issues.length) {
    line(C.green('    ✅ 全部通过，可以直接创建'));
  } else {
    blockers.forEach((i) => line(C.red(`    ✗ [阻塞] ${i.field}`) + `  ${i.message}`));
    warns.forEach((i) => line(C.yellow(`    ! [警告] ${i.field}`) + `  ${i.message}`));
    const infos = issues.filter((i) => i.level === 'info');
    infos.forEach((i) => line(C.cyan(`    · [提示] ${i.field}`) + `  ${i.message}`));
    line('');
    line(
      `    合计：${blockers.length ? C.red(`${blockers.length} 个阻塞项`) : C.green('0 个阻塞项')}` +
        `，${warns.length} 个警告`,
    );
  }
  line('');

  // ---------- 真实请求预览 ----------
  if (blockers.length) {
    line(C.dim('  —— 存在阻塞项，跳过请求预览。补齐字段后再看 ——'));
    line('');
    return;
  }

  const body = toCreateRequest(n) as unknown as Record<string, unknown>;
  const bodyString = compactBody(body);
  const appKey = GOOFISH_APP_KEY();
  const appSecret = GOOFISH_APP_SECRET();
  const sellerId = GOOFISH_SELLER_ID();
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = appKey && appSecret ? genSign({ appKey, appSecret, timestamp, bodyString, sellerId }) : '<需配置 GOOFISH_APP_KEY/SECRET>';

  const shownKey = appKey ? appKey.slice(0, 6) + '…' + appKey.slice(-3) : '<未配置 GOOFISH_APP_KEY>';
  line(C.b('  将发送的真实请求'));
  line(C.dim('    —— 创建商品 ——'));
  line(`    POST ${C.cyan('https://open.goofish.pro' + EP.productCreate)}` +
      `?appid=${shownKey}&timestamp=${timestamp}${sellerId ? `&seller_id=${sellerId}` : ''}&sign=${sign}`);
  line(`    Content-Type: application/json; charset=utf-8`);
  line(`    body.md5 = ${md5(bodyString)}`);
  line('');
  line(C.dim('    body（压缩 JSON，即签名所用原文）：'));
  line(`    ${bodyString}`);
  line('');

  // 上架请求
  const publishBody = {
    product_id: '<创建接口返回的 product_id>',
    user_name: n.publish_shop.map((s) => s.user_name),
    notify_url: '<你的推送地址，强烈建议填>',
  };
  line(C.dim('    —— 上架商品（拿到 product_id 后调用）——'));
  line(`    POST ${C.cyan('https://open.goofish.pro' + EP.productPublish)}?appid=…&timestamp=…&sign=…`);
  line(`    ${compactBody(publishBody)}`);
  line('');
}

function main() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const drafts = readDrafts(arg);

  line('');
  line(C.b('══════ 闲管家 商品草稿预览 ══════'));
  if (!drafts.length) {
    line('');
    line(C.yellow('  drafts/ 目录下没有找到任何 .json 草稿。'));
    line(`  目录位置：${DRAFTS_DIR}`);
    line('');
    process.exit(0);
  }
  line(C.dim(`  共 ${drafts.length} 份草稿`));

  for (const d of drafts) previewOne(d.file, d.draft);

  // 汇总
  const summary = drafts.map((d) => {
    const n = normalizeDraft(JSON.parse(JSON.stringify(d.draft)) as ProductDraft);
    const b = validateDraft(n).filter((i) => i.level === 'blocker').length;
    return { name: path.basename(d.file), blockers: b };
  });
  line(C.b('══════ 汇总 ══════'));
  for (const s of summary) {
    line(`  ${s.blockers === 0 ? C.green('可上架') : C.red(`阻塞 ${s.blockers}`)}  ${s.name}`);
  }
  line('');
  const total = summary.reduce((a, s) => a + s.blockers, 0);
  if (total === 0) {
    line(C.green('  全部草稿就绪。'));
    line(`  下一步：${C.b('npm run gf:publish')}（需先在 .env 设置 GOOFISH_LIVE=true）`);
  } else {
    line(C.yellow(`  共 ${total} 个阻塞项待解决。多数需要联网凭证：类目 ID 要用 gf:categories 查。`));
  }
  line('');
}

main();
