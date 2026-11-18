#!/usr/bin/env node
/**
 * 每日体检 —— 把「会静默把生意搞停」的几件事一次看清。
 *
 *   npx tsx scripts/ops-check.ts            打印报告，并写入 out/ops-YYYY-MM-DD.md
 *   npx tsx scripts/ops-check.ts --no-file  只打印
 *
 * 为什么要有它：下面每一项坏掉时都**不会主动报错**，只会在某个环节突然卡死，
 * 而且症状和根因离得很远（比如 token 过期表现为"转存失败"，空间满表现为 13077）。
 *
 *   1. 百度 access_token 剩余天数 —— 30 天有效、refresh 是一次性的，过期后所有网盘操作停摆
 *   2. 百度账号剩余空间        —— 满了就 errno=13077，转存/出链全失败
 *   3. 网关可达性              —— 关系到买家能不能收到货
 *   4. 管理端可达性            —— 流水线脚本的前提
 *   5. 发布队列积压            —— 有没有卡住发不出去的商品
 *   6. ⭐ 发货覆盖              —— 已上架的商品里，有多少在卡密池里**有内容**。
 *                                 缺了就是「卖了发不出货」，而且买家不投诉你不会知道。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenStatus, loadToken } from '../packages/bdpan-core/src/token';
import { quota } from '../packages/bdpan-core/src/files';
import { cardPool, loadCatalog } from '../packages/xgj-gateway/src/store';
import { isAdminUp, adminState, ADMIN_URL } from './lib/admin.mjs';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY = `http://127.0.0.1:${process.env.XGJ_PORT || 8787}`;
const NO_FILE = process.argv.includes('--no-file');

const rows: string[] = [];
const alerts: string[] = [];
const line = (s = '') => rows.push(s);

const fmtGB = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

/** 各项统一成 { ok, text, alert? } 的形态，方便汇总告警 */
function mark(ok: boolean, text: string, alert?: string) {
  if (!ok && alert) alerts.push(alert);
  return `${ok ? '✅' : '⚠️'} ${text}`;
}

/* ---------------- 1. 百度 token ---------------- */
let tokenLine = '（读取失败）';
try {
  const t = loadToken();
  if (!t) {
    tokenLine = mark(false, '未授权（需 npm run auth）', '百度网盘未授权，所有网盘操作都会失败');
  } else {
    const days = (t.expires_at - Date.now()) / 86400000;
    tokenLine = mark(
      days >= 7,
      tokenStatus(),
      days < 7 ? `百度 access_token 只剩 ${days.toFixed(1)} 天，请及时重新授权（npm run auth）` : undefined,
    );
  }
} catch (e: any) {
  tokenLine = mark(false, `读取失败：${e?.message ?? e}`, '读取百度 token 失败');
}

/* ---------------- 2. 账号空间 ---------------- */
let quotaLine = '（查询失败）';
try {
  const q = await quota();
  const free = q.total - q.used;
  quotaLine = mark(
    free > 20 * 1024 ** 3,
    `总 ${fmtGB(q.total)} · 已用 ${fmtGB(q.used)} · 剩余 ${fmtGB(free)}`,
    free <= 20 * 1024 ** 3 ? `网盘剩余仅 ${fmtGB(free)}，转存会报 errno=13077（空间不足）` : undefined,
  );
} catch (e: any) {
  quotaLine = mark(false, `查询失败：${e?.message ?? e}`, '查询网盘容量失败（可能需要重新授权）');
}

/* ---------------- 3. 网关（本机 + ⭐公网隧道） ---------------- */
let gatewayLine = '（不可达）';
try {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3000);
  const r = await fetch(`${GATEWAY}/__health`, { signal: ac.signal });
  clearTimeout(t);
  gatewayLine = mark(r.ok, `可达 ${GATEWAY}（HTTP ${r.status}）`, r.ok ? undefined : '网关健康检查未通过，买家可能收不到货');
} catch (e: any) {
  gatewayLine = mark(false, `不可达 ${GATEWAY}`, '网关不可达 —— 买家下单后无法出卡。检查 npm run gw:ps / docker compose logs');
}

/**
 * ⭐ 公网隧道检查 —— 2026-10-08 真实事故后加的。
 *
 * 事故：Cloudflare **Quick Tunnel 在 05:09 被回收**，cloudflared 进程还活着、
 * 容器显示 Up 42h，只是每 3 分钟重试一次并打印 `Unauthorized: Tunnel not found`。
 * 本机 8787 一直健康，所以只测本机的体检报「✅ 可达」，**给了假的安心**；
 * 当天有人拍了一单，管家根本连不上我们，没有回调 → 没发货，而且毫无提示。
 *
 * 所以必须**从公网侧**打一次，而且不能只看 HTTP 通不通，
 * 要确认响应确实是我们的网关（否则可能打到别人的域名/隧道）。
 */
let tunnelLine = '（未启用/未取到）';
const CONTAINER = process.env.TUNNEL_CONTAINER || 'xgj-tunnel';
try {
  // ⚠️ cloudflared 的日志走 **stderr**，execFileSync 只拿 stdout → 必须合并两路
  const { spawnSync } = await import('node:child_process');
  const cp = spawnSync('docker', ['logs', CONTAINER], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const logs = `${cp.stdout ?? ''}\n${cp.stderr ?? ''}`;
  const urls = logs.match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/g) || [];
  const url = urls[urls.length - 1];
  if (!url) {
    tunnelLine = mark(false, `没在 ${CONTAINER} 日志里找到 trycloudflare 地址`, '公网隧道地址缺失 —— 管家无法回调');
  } else {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 12000);
    // 用 GET 打一个只接受 POST 的接口：预期 4xx，但响应文案必须来自我们的网关
    const r = await fetch(`${url}/goofish/open/info`, { signal: ac.signal });
    const body = (await r.text()).slice(0, 200);
    clearTimeout(t);
    const isOurs = /闲管家|open\.goofish|Method Not Allowed|商户不存在/.test(body);
    tunnelLine = mark(
      isOurs,
      `${url} → HTTP ${r.status}${isOurs ? '（响应来自本网关）' : '（响应不像来自本网关！）'}`,
      isOurs ? undefined : `公网隧道不可用或已指向别处：${url}。管家回调进不来 → 拍了单也不会发货。跑 docker compose restart cloudflared 拿新地址，并到闲管家「货源授权信息 → 接口网关」更新`,
    );
    if (url) tunnelLine += `\n  当前地址：${url}`;
  }
} catch (e: any) {
  const msg = String(e?.message ?? e);
  const notFound = /No such container|Cannot connect to the Docker/.test(msg);
  tunnelLine = mark(
    false,
    notFound ? `取不到 ${CONTAINER} 日志：${msg.slice(0, 80)}` : `公网隧道探测失败：${msg.slice(0, 120)}`,
    '公网隧道不可用 —— 管家回调进不来，拍了单也不会发货。跑 docker compose restart cloudflared，再去闲管家更新「接口网关」地址',
  );
}

/* ---------------- 4. 管理端 ---------------- */
const adminUp = await isAdminUp(2500);
const adminLine = mark(adminUp, adminUp ? `在线 ${ADMIN_URL}` : `离线 ${ADMIN_URL}`, adminUp ? undefined : '管理端离线（npm run admin），发布/导入等脚本会失败');

/* ---------------- 5. 队列 ---------------- */
let queueBlock = '（未取到）';
let publishedCodes: string[] = [];
if (adminUp) {
  try {
    const st: any = await adminState();
    const s = st.stats ?? {};
    queueBlock = `资源 ${s.resources_total ?? '?'} · 待发(ready) ${s.ready ?? 0} · 阻塞(blocked) ${s.blocked ?? 0} · 已上架(published) ${s.published ?? 0}`;
    const byCat = s.by_category ? Object.entries(s.by_category).map(([k, v]) => `${k}=${v}`).join(' / ') : '';
    if (byCat) queueBlock += `\n  分类：${byCat}`;

    // ⚠️ 区分两类阻塞：只卡合规的是「排队中，等发布」，属正常；
    //    卡在缺链接/缺图这类才是真的发不出去。
    const blockedItems = (st.resources || []).filter((r: any) => r.status === 'blocked');
    const onlyCompliance = blockedItems.filter(
      (r: any) => (r.draft_issues || []).every((i: any) => i.level !== 'blocker' || i.field === 'compliance'),
    );
    const hardBlocked = blockedItems.filter((r: any) => !onlyCompliance.includes(r));
    if (onlyCompliance.length) {
      queueBlock += `\n  其中 ${onlyCompliance.length} 个是「只等合规放行」的正常排队`;
    }
    if (hardBlocked.length) {
      const sample = hardBlocked.slice(0, 5).map((r: any) => r.id).join('、');
      queueBlock += `\n  ⚠️ ${hardBlocked.length} 个卡在非合规原因（缺链接/缺图等）：${sample}`;
      alerts.push(`${hardBlocked.length} 个商品卡在非合规阻塞项（缺链接/缺图），不会自动发布`);
    }
    try {
      const listings = JSON.parse(fs.readFileSync(path.join(PROJ, 'drafts', '.listings.json'), 'utf8'));
      publishedCodes = Object.keys(listings);
    } catch { /* 还没发布过 */ }
  } catch (e: any) {
    queueBlock = `（读取失败：${e?.message ?? e}）`;
  }
}

/* ---------------- 6. ⭐ 发货覆盖 ---------------- */
const cards = cardPool();
const catalog = loadCatalog();
const withContent = (code: string) => (cards[code] ?? []).some((c) => !!c.card_pwd?.trim());
const missingDelivery = publishedCodes.filter((c) => !withContent(c));
const orphanGoods = Object.keys(cards).filter((k) => !catalog.goods.some((g) => g.goods_no === k));

let coverageLine = '（管理端离线，无法比对）';
if (publishedCodes.length) {
  const covered = publishedCodes.length - missingDelivery.length;
  coverageLine = mark(
    missingDelivery.length === 0,
    `有发布记录 ${publishedCodes.length} 个，卡密池有内容 ${covered} 个，缺 ${missingDelivery.length} 个`,
    missingDelivery.length ? `有 ${missingDelivery.length} 个已上架商品在卡密池里没有发货内容 → 买家拍下发不出货。跑 npm run card:sync` : undefined,
  );
  if (missingDelivery.length) {
    coverageLine += `\n  缺失：${missingDelivery.slice(0, 12).join('、')}${missingDelivery.length > 12 ? ' …' : ''}`;
  }
} else if (adminUp) {
  coverageLine = '暂无已上架商品';
}
const cardPoolLine = `卡密池 ${Object.keys(cards).length} 个键 · 货源商品 ${catalog.goods.length} 个` +
  (orphanGoods.length ? ` · ⚠️ ${orphanGoods.length} 个卡密无对应货源商品` : '');

/* ---------------- 7. ⭐ 未真正上架（停在闲管家草稿） ---------------- */
// 「接口受理成功」≠「已上架」。2026-10-08 实测：579 个插件里后 286 个
// 接口全部返回成功、product_id 也记了，但线上其实是草稿（product_status=21）。
let draftStuckLine = '（管理端离线，无法比对）';
try {
  const listings = JSON.parse(fs.readFileSync(path.join(PROJ, 'drafts', '.listings.json'), 'utf8'));
  const stuck = Object.entries<any>(listings).filter(([, v]) => v.state === 'draft');
  const shelved = Object.entries<any>(listings).filter(([, v]) => v.state === 'down_shelved');
  draftStuckLine = mark(
    stuck.length === 0,
    `停在闲管家草稿（未真正上架）${stuck.length} 个${shelved.length ? ` · 已下架 ${shelved.length} 个` : ''}`,
    stuck.length
      ? `有 ${stuck.length} 个商品接口受理成功但**线上仍是草稿**，买家看不到。`
        + '重跑 `node scripts/drip-publish.mjs --every 300` 会自动重试它们（队列里已标为 ready）；若重试仍无效，'
        + '多半是账号级上架上限/风控，需去闲管家后台看「失败原因」列。'
      : undefined,
  );
} catch { /* 无台账 */ }

/* ---------------- 汇总输出 ---------------- */
const now = new Date();
const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

line(`# 运营体检 · ${stamp}`);
line();
if (alerts.length) {
  line(`## ⚠️ 需要处理（${alerts.length}）`);
  line();
  for (const a of alerts) line(`- ${a}`);
} else {
  line('## ✅ 全部正常，无需处理');
}
line();
line('## 明细');
line();
line(`- 百度授权：${tokenLine}`);
line(`- 网盘空间：${quotaLine}`);
line(`- 网关：${gatewayLine}`);
line(`- 公网隧道：${tunnelLine}`);
line(`- 管理端：${adminLine}`);
line(`- 发布队列：${queueBlock}`);
line(`- 发货覆盖：${coverageLine}`);
line(`- 上架实况：${draftStuckLine}`);
line(`- ${cardPoolLine}`);
line();

const report = rows.join('\n');
console.log('\n' + report);

if (!NO_FILE) {
  const outDir = path.join(PROJ, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `ops-${stamp.slice(0, 10)}.md`);
  fs.writeFileSync(file, report + '\n', 'utf8');
  console.log(`报告已写入 ${file}`);
}

// 有告警时用非零退出码，便于自动化里一眼看出「需要人看」
process.exit(alerts.length ? 2 : 0);
