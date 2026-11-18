#!/usr/bin/env node
/**
 * 重发「已提交过、但始终没真正上架」的商品。
 *
 * ── 为什么需要它（与 drip-publish.mjs 的分工）
 * `drip-publish.mjs` 的队列取的是「**还没发布过**」的资源（`/api/publish/state` 里
 * `status === 'ready'`）。而 2026-10-08 这次事故里卡住的那批，**在台账里已经有了
 * product_id**，所以它们被判成「已发布」，永远进不了那个队列 —— 那 286 个就成了
 * 谁都不管的状态。
 *
 * ── 事故背景（这是本脚本存在的理由）
 * 2026-10-08 实测：店铺在售数触顶（行业常见上限 500，实测撞在 450~500 之间）后，
 * 闲管家对 `product/publish` **仍然返回成功**，商品也照样在闲管家建立，
 * 但闲鱼侧永远不落地 —— 现象是 `product_status=21`（草稿）、`publish_shop[].item_id=0`。
 * 用户开通「运营提效包」把上限提到 3000 之后，这些商品**再点一次上架就能成功**。
 *
 * ── 判定「真的上架了吗」只看一个东西
 * **闲鱼 item_id**。接口受理（publish 返回 ok）≠ 已上架 —— 这次事故里 286 个都是
 * 「接口返回成功」的。所以本脚本一律以 `publish_shop[0].item_id > 0` 为准。
 *
 * ── 用法
 *   npx tsx scripts/republish-stuck.ts --dry                 只看名单，不发
 *   npx tsx scripts/republish-stuck.ts --every 30 --limit 10 发 10 个，每个间隔 30s
 *   npx tsx scripts/republish-stuck.ts --all                 把名单里剩下的全发
 *   npx tsx scripts/republish-stuck.ts --only BD-GFX-102799  只发指定的几个
 *
 * ⚠️ 幂等且安全：
 *   · 只挑 `product_status === 21`（草稿）的，已上架（22）的绝不动
 *   · 不新建商品（用已有 product_id 重新提交上架），不会产生重复商品
 *   · 连续失败 N 个自动熔断（识别「账号级上限/风控」而不是单品问题）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProduct, publishProduct } from '../packages/goofish-adapter/src/api';
// @ts-ignore —— 纯 JS 共享模块（.d.ts 不存在，见 scripts/lib/preflight.mjs 顶部说明）
import { checkDraft, cardTextOf } from './lib/preflight.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRAFTS = path.join(ROOT, 'drafts');

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string, dft: number) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : dft;
};

const DRY = has('--dry');
const EVERY = Math.max(0, val('--every', 30)); // 每个之间的间隔（秒）
const LIMIT = has('--all') ? Number.MAX_SAFE_INTEGER : Math.max(1, val('--limit', 10));
const VERIFY_WAIT = Math.max(10, val('--verify-wait', 90)); // 全部提交后等多久再核对
const FAIL_STREAK_LIMIT = Math.max(2, val('--fail-streak', 5));
/**
 * ⭐ 上架前体检开关。
 * 2026-10-08 事故：一个 Blender 插件的**封面图带「GPT」字样** → 账号被封控。
 * 所以**默认开启**体检（文字 + 图片 OCR + 内容识别）；应急时才用 --skip-preflight 关闭。
 */
const SKIP_PREFLIGHT = has('--skip-preflight');
const onlyIdx = argv.indexOf('--only');
const ONLY =
  onlyIdx >= 0
    ? argv
        .slice(onlyIdx + 1)
        .filter((a) => !a.startsWith('--'))
        .slice(0, 50)
    : [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const line = (s = '') => console.log(`[${stamp()}] ${s}`);
const b = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const listings: Record<string, any> = JSON.parse(
  fs.readFileSync(path.join(DRAFTS, '.listings.json'), 'utf8'),
);

/**
 * 永久排除名单（`drafts/.excluded.json`）。
 * 内容违规 / 法定违禁品 / 侵权的那批 —— 无论台账是什么状态，**一律不发**。
 * 与后台的 publish.run 闸门读同一个文件。
 */
const excludedCodes: Record<string, any> = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DRAFTS, '.excluded.json'), 'utf8')) || {};
  } catch {
    return {};
  }
})();

/** 读草稿里的店铺会员名（重新提交上架要带） */
function shopOf(code: string): string[] {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(DRAFTS, `${code}.json`), 'utf8'));
    return (d.publish_shop ?? []).map((s: any) => s.user_name).filter(Boolean);
  } catch {
    return [];
  }
}

console.log('');
console.log(b('══════ 重发「卡在草稿」的商品 ══════'));
console.log(`  间隔 ${EVERY}s　上限 ${LIMIT === Number.MAX_SAFE_INTEGER ? '全部' : LIMIT} 个` +
  `${ONLY.length ? `　指定 ${ONLY.length} 个` : ''}${DRY ? '　' + dim('【dry-run】') : ''}`);
console.log('');

/* ---------------- 1. 找出真正还是草稿的 ---------------- */
const candidateCodes = (ONLY.length ? ONLY : Object.keys(listings))
  .filter((c) => ONLY.length > 0 || ['draft', 'unknown', 'pending_review'].includes(listings[c]?.state))
  .filter((c) => listings[c]?.product_id)
  .filter((c) => !excludedCodes[c])
  .sort();

const excludedSkipped = Object.keys(listings).filter(
  (c) => excludedCodes[c] && ['draft', 'unknown', 'pending_review'].includes(listings[c]?.state),
).length;
if (excludedSkipped) {
  line(dim(`已跳过 ${excludedSkipped} 个「永久排除」的草稿（drafts/.excluded.json）`));
}

line(`候选 ${candidateCodes.length} 个（台账 state 看起来没上架的），逐个核对线上真实状态…`);

type Target = { code: string; pid: number; title: string };
const targets: Target[] = [];
let alreadyLive = 0;

for (const [i, code] of candidateCodes.entries()) {
  const pid = Number(listings[code].product_id);
  try {
    const d: any = await getProduct(pid);
    const itemId = Number(d.publish_shop?.[0]?.item_id ?? 0);
    if (Number(d.product_status) === 21 && !itemId) {
      targets.push({ code, pid, title: String(d.title ?? '') });
      // 台账顺手修正，避免下次又要重新核对
      listings[code].state = 'draft';
    } else {
      alreadyLive++;
      const st = Number(d.product_status);
      listings[code].state =
        st === 22 ? 'on_sale' : st === 23 || st === 33 ? 'sold_out' : st === 31 || st === 36 ? 'down_shelved' : 'unknown';
    }
  } catch (e: any) {
    line(`  ⚠️ ${code} 查询失败，跳过：${String(e?.message ?? e).slice(0, 70)}`);
  }
  if ((i + 1) % 40 === 0) line(`  …已核对 ${i + 1}/${candidateCodes.length}　（其中真正卡草稿 ${targets.length}）`);
}

fs.writeFileSync(path.join(DRAFTS, '.listings.json'), JSON.stringify(listings, null, 2) + '\n');

console.log('');
line(`核对完成：真正卡在草稿 ${b(String(targets.length))} 个　已在上架/其它状态 ${alreadyLive} 个`);
if (targets.length) {
  console.log('');
  for (const t of targets.slice(0, 8)) console.log(`    ${t.code.padEnd(16)} ${t.title.slice(0, 34)}`);
  if (targets.length > 8) console.log(`    …其余 ${targets.length - 8} 个`);
}
console.log('');

if (!targets.length) {
  line(green('没有需要重发的商品，退出。'));
  process.exit(0);
}
if (DRY) {
  line(dim('dry-run，未提交任何上架请求。'));
  process.exit(0);
}

/* ---------------- 2. 逐个重新提交上架 ---------------- */
const queue = targets.slice(0, LIMIT === Number.MAX_SAFE_INTEGER ? undefined : LIMIT);
line(`开始重发 ${queue.length} 个（不新建商品，只重新提交上架）…`);
console.log('');

let submitted = 0;
let failed = 0;
let blockedByPreflight = 0;
let failStreak = 0;
const blockedCodes: string[] = [];
const submittedCodes: string[] = [];

for (const [i, t] of queue.entries()) {
  const t0 = Date.now();
  try {
    const shops = shopOf(t.code);
    if (!shops.length) {
      line(`[${i + 1}/${queue.length}] ${t.code} ${red('跳过：草稿里没有店铺信息')}`);
      failed++;
      continue;
    }
    // ⭐⭐ 上架前体检 —— 违规品绝不提交上架（GPT 字样、过度暴露图都会导致封控）
    if (!SKIP_PREFLIGHT) {
      let pf: any;
      try {
        pf = await checkDraft(t.code, { text: true, images: true, cardText: cardTextOf(t.code) });
      } catch (e: any) {
        line(`[${i + 1}/${queue.length}] ${t.code.padEnd(16)} ${red('体检异常')}　${String(e?.message ?? e).slice(0, 70)}`);
        blockedByPreflight++;
        blockedCodes.push(t.code);
        continue;
      }
      if (pf.block.length) {
        blockedByPreflight++;
        blockedCodes.push(t.code);
        const first = String(pf.block[0]).split('\n')[0].slice(0, 84);
        line(`[${i + 1}/${queue.length}] ${t.code.padEnd(16)} ${red('⛔ 已拦截')}　${first}`);
        continue;
      }
    }

    await publishProduct({ product_id: t.pid, user_name: shops });
    submitted++;
    failStreak = 0;
    submittedCodes.push(t.code);
    line(`[${i + 1}/${queue.length}] ${t.code.padEnd(16)} ${green('已提交上架')}　${t.title.slice(0, 26)}`);
  } catch (e: any) {
    failed++;
    failStreak++;
    line(`[${i + 1}/${queue.length}] ${t.code.padEnd(16)} ${red('提交失败')}　${String(e?.message ?? e).slice(0, 80)}`);
    if (failStreak >= FAIL_STREAK_LIMIT) {
      console.log('');
      line(red(`⛔ 连续 ${failStreak} 个提交失败 —— 更像账号级问题（上限/风控），已主动停止。`));
      break;
    }
  }

  const used = (Date.now() - t0) / 1000;
  const wait = Math.max(0, EVERY - used);
  if (wait > 0 && i < queue.length - 1) await sleep(wait * 1000);
}

console.log('');
line(`提交完成：成功 ${b(String(submitted))} 个，失败 ${failed} 个` +
  (blockedByPreflight ? `，${red(`体检拦截 ${blockedByPreflight} 个`)}` : ''));
if (blockedCodes.length) {
  line(dim('  被拦截的（改完内容再来）：'));
  line(dim('    ' + blockedCodes.slice(0, 12).join(' ') + (blockedCodes.length > 12 ? ` …其余 ${blockedCodes.length - 12} 个` : '')));
  line(dim('  查看详情：npm run preflight -- ' + blockedCodes.slice(0, 3).join(' ')));
}

/* ---------------- 3. 等异步上架落地，再核对 ---------------- */
if (submittedCodes.length) {
  line(`等 ${VERIFY_WAIT}s 让闲鱼侧异步上架落地，再核对真实结果…`);
  await sleep(VERIFY_WAIT * 1000);

  let live = 0;
  const stillDraft: string[] = [];
  for (const [i, code] of submittedCodes.entries()) {
    const pid = Number(listings[code].product_id);
    try {
      const d: any = await getProduct(pid);
      const itemId = Number(d.publish_shop?.[0]?.item_id ?? 0);
      if (itemId && Number(d.product_status) !== 21) {
        live++;
        listings[code].state = Number(d.product_status) === 22 ? 'on_sale' : 'unknown';
        console.log(`    ✅ ${code.padEnd(16)} item_id=${itemId}`);
      } else {
        stillDraft.push(code);
        console.log(`    ⏳ ${code.padEnd(16)} 仍是草稿 / 处理中（item_id=${itemId || 0}）`);
      }
    } catch (e: any) {
      stillDraft.push(code);
      console.log(`    ⚠️ ${code.padEnd(16)} 核对失败：${String(e?.message ?? e).slice(0, 60)}`);
    }
    if ((i + 1) % 30 === 0) await sleep(3000); // 避开 QPS
  }

  fs.writeFileSync(path.join(DRAFTS, '.listings.json'), JSON.stringify(listings, null, 2) + '\n');

  console.log('');
  line(`核对结果：${green(`${live} 个已真正上架`)}　${stillDraft.length ? red(`${stillDraft.length} 个还没落地`) : ''}`);
  if (stillDraft.length) {
    line(dim(`未落地的可用：npx tsx scripts/republish-stuck.ts --only ${stillDraft.slice(0, 10).join(' ')}`));
  }
  console.log('');
  line(dim('提醒：发布成功后记得跑 npm run card:sync --all，把发货内容灌进卡密池。'));
}
