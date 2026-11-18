#!/usr/bin/env node
/**
 * 节流发布器 —— 每隔 N 秒发布队列里的**一个**商品。
 *
 * 为什么需要它：闲鱼对「短时间集中上架」有风控，一次发几十个容易触发限流。
 * 用户要求：5 分钟发一个，一个个来。
 *
 * 用法：
 *   node scripts/drip-publish.mjs --every 300 --limit 10
 *   node scripts/drip-publish.mjs --every 300 --limit 3 --category 3d-model
 *   node scripts/drip-publish.mjs --dry-run            # 只看会发哪些，不真发
 *
 * 每个商品的节奏：
 *   放行合规闸门（若只卡在这一项）→ 发布 → 等 45s 让异步上架落地 → 同步核对 item_id
 *   → 补足到 --every 秒 → 下一个
 *
 * 依赖：管理端在 127.0.0.1:8790 运行；商品必须已有发布草稿。
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAdminUp } from './lib/admin.mjs';

const B = 'http://127.0.0.1:8790';
// scripts/ 的上一级就是项目根
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'drafts', '.publish-drip.log');

const NOTE =
  '用户 2026-10-07 明确要求按节流方式（每 5 分钟一个）发布。' +
  '内容为第三方素材站（GFXCamp）资源，授权风险由用户自行承担。';

/* ---------------- CLI ---------------- */
const argv = process.argv.slice(2);
const val = (name, dft) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dft;
};
const has = (name) => argv.includes(name);

const EVERY = Math.max(10, Number(val('--every', 300)));   // 秒
const LIMIT = Math.max(1, Number(val('--limit', 1)));      // 本次最多发几个
const CATEGORY = has('--category') ? val('--category', null) : null;
const DRY = has('--dry-run');
const SYNC_WAIT = 45;                                       // 发布后等异步上架的秒数

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 连续失败熔断阈值。
 * 用于识别「账号级拒绝」而不是单个商品的问题：实测 2026-10-08 出现
 * 「前 294 个全部成功、之后 285 个全部失败」的平台侧上限，
 * 及时熔断能避免继续把商品刷成草稿、也避免加重风控。
 */
const FAIL_STREAK_LIMIT = Math.max(2, Number(val('--fail-streak', 5)));
const stamp = () => new Date().toTimeString().slice(0, 8);
const logLine = (s) => {
  const line = `[${stamp()}] ${s}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* 日志失败不影响发布 */ }
};

const api = async (p) => {
  const r = await fetch(`${B}${p}`, { cache: 'no-store' });
  return r.json();
};
const post = async (action, body) => {
  const r = await fetch(`${B}/api/pipeline/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
};

/**
 * 管理端短暂不可用时自动恢复。
 *
 * ⚠️ 2026-10-07 踩过：发布任务跑到第 69 个时管理端被重启，
 *    fetch 直接抛 ECONNREFUSED，**未被捕获 → 整个进程崩掉**，
 *    剩下 76 个商品无声无息地停在那里（日志里只有一段堆栈）。
 *    发布是长时间任务，中途遇到管理端重启/崩溃重拉是常态，必须能自愈。
 */
async function withRetry(fn, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const why = e?.cause?.code || e?.code || e?.message || String(e);
      logLine(`   ⚠️ 管理端调用失败（${why}），尝试自动恢复…（第 ${i + 1}/${attempts} 次）`);
      const up = await ensureAdminUp({ quiet: true });
      await sleep(up ? 800 : 2500 * (i + 1));
    }
  }
  throw lastErr;
}

/** 阻塞项是否只有「合规闸门」一项 —— 其余阻塞（缺链接、缺图等）不允许自动放行 */
const onlyComplianceBlocks = (r) =>
  (r.draft_issues || []).every((i) => i.level !== 'blocker' || i.field === 'compliance');

/**
 * ⭐ 发布成功后立刻把发货内容灌进网关卡密池。
 *
 * 为什么必须**每次发布之后**就跑，而不是事后手动补：
 *   发布是自动连续的，而灌卡密曾经是独立的一步 —— 于是每发一个商品就多一个
 *   「已上架但卡密池为空」的空档。实测出现过 **112 个已上架、只有 88 个有内容**，
 *   中间 24 个一旦被买家拍下就是**发不出货**，而且不会有任何报错提醒。
 *   （`scripts/card-sync.ts` 是幂等的，已发出去过的卡密不会被覆盖。）
 */
async function syncCardPool() {
  await new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'scripts/card-sync.ts'], { cwd: ROOT, stdio: 'ignore' });
    child.on('error', () => resolve()); // 灌卡密失败不该中断发布，交给 npm run ops 兜住
    child.on('exit', () => resolve());
  });
}

/**
 * 本轮已试过的商品 —— 挑下一个时跳过。
 *
 * 为什么必须跳过：上架失败的商品在队列里仍是 ready，若不排除，
 * pickNext 每次都会挑中同一个，于是把整整一轮都浪费在同一件商品上
 * （实测：limit 3 时三次都在重试同一个）。跳过它才能推进整个队列。
 */
const triedThisRun = new Set();

/** 挑下一个：优先 ready，其次「只卡合规」的 blocked */
async function pickNext() {
  const st = await withRetry(() => api('/api/publish/state'));
  const pool = (st.resources || [])
    .filter((r) => !CATEGORY || r.category === CATEGORY)
    .filter((r) => !triedThisRun.has(r.id));
  return (
    pool.find((r) => r.status === 'ready' && r.draft_code) ||
    pool.find((r) => r.status === 'blocked' && r.draft_code && onlyComplianceBlocks(r)) ||
    null
  );
}

/** 发布一个：返回 { ok, item_id, label } */
async function publishOne(r) {
  const code = r.draft_code;
  if (r.status === 'blocked') {
    const c = await withRetry(() => post('draft.save', { code, patch: { compliance_clean: true, compliance_note: NOTE } }));
    if (!c.ok) return { ok: false, label: `放行合规失败：${c.error}` };
  }
  const p = await withRetry(() => post('publish.run', { code, confirm: true }));
  if (!p.ok) return { ok: false, label: `发布失败：${p.error}` };

  const pid = p.detail?.product_id;
  logLine(`   已提交 product_id=${pid}，等 ${SYNC_WAIT}s 核对…`);
  await sleep(SYNC_WAIT * 1000);

  const s = await withRetry(() => post('publish.sync', { code }));
  if (!s.ok) return { ok: false, label: `同步失败：${s.error}`, pid };

  // ⚠️⚠️ 关键：接口受理 ≠ 已上架。实测 2026-10-08 踩过 ——
  //   579 个插件里后 286 个「接口返回成功」，但商品其实停在闲管家草稿箱（product_status=21），
  //   而当时的判定只看 publish.run 的 ok，于是全部记成 ✅，没人发现。
  //   现在：拿不到闲鱼 item_id（=0 / 空）一律判为「未真正上架」。
  const itemId = s.detail?.item_id;
  if (!itemId) {
    return {
      ok: false,
      label: `未真正上架（线上仍是草稿 / 处理中）：${s.detail?.status_label || '状态待确认'}`,
      pid,
      notLive: true,
    };
  }
  return { ok: true, item_id: itemId, label: s.detail?.status_label || '—', pid };
}

/* ---------------- 主循环 ---------------- */
console.log(`节流发布器　每 ${EVERY}s 一个　本次上限 ${LIMIT} 个${CATEGORY ? `　类别=${CATEGORY}` : ''}${DRY ? '　【dry-run】' : ''}\n`);

// 管理端没起的话，旧表现是 fetch failed，看着像网络问题，实际只是没起进程
if (!(await ensureAdminUp())) process.exit(1);

let done = 0, failed = 0, failStreak = 0;
while (done + failed < LIMIT) {
  const t0 = Date.now();
  const r = await pickNext();

  if (!r) {
    logLine('没有可发布的商品了（都已上架 / 卡在非合规项 / 本轮已试过），退出。');
    break;
  }

  triedThisRun.add(r.id);
  logLine(`[${done + failed + 1}/${LIMIT}] ${r.display_name}　¥${(r.price_fen / 100).toFixed(2)}　${r.status}`);

  if (DRY) {
    logLine('   （dry-run，不实际发布）');
    done++;
  } else {
    let res;
    try {
      res = await publishOne(r);
    } catch (e) {
      res = { ok: false, label: `异常：${e?.cause?.code || e?.message || e}` };
    }
    if (res.ok) {
      done++;
      failStreak = 0;
      logLine(`   ✅ ${res.label}　item_id=${res.item_id}`);
      // ⭐ 必须紧跟发布：否则这个商品在卡密池里是空的，买家拍下发不出货
      await syncCardPool();
      logLine('   🗂  发货内容已灌入卡密池');
    } else {
      failed++;
      failStreak++;
      logLine(`   ❌ ${res.label}`);
      if (res.notLive || res.pid) {
        logLine(`      商品已在闲管家建立（product_id=${res.pid ?? '?'}），**不要重建**；`);
        logLine(`      稍后重试上架：GOOFISH_LIVE=true npm run gf:publish -- ${r.draft_code} --live`);
      }
      if (failStreak >= FAIL_STREAK_LIMIT) {
        logLine(`\n⛔ 连续 ${failStreak} 个未能真正上架 —— 这通常是**账号级上限/风控**，不是单个商品的问题。`);
        logLine('   已主动停止，避免继续把商品刷成草稿。');
        logLine('   排查方向：闲管家后台看这些商品的「失败原因」列；确认在售数量是否已达店铺上限。');
        logLine('   确认后重跑本脚本即可（已上架的会自动跳过，草稿的会被重试上架）。');
        break;
      }
    }
  }

  // 补足到 EVERY 秒（处理耗时算在里面）
  const used = (Date.now() - t0) / 1000;
  const wait = Math.max(5, EVERY - used);
  const more = done + failed < LIMIT;
  if (more) {
    logLine(`   等 ${wait.toFixed(0)}s 后继续…\n`);
    await sleep(wait * 1000);
  }
}

logLine(`\n本轮结束：成功 ${done} · 失败 ${failed}`);

// 收尾再灌一次：万一最后一个商品在这之后才落地，或者中途有过异常，这里兜住
await syncCardPool();
logLine('已重新核对卡密池');

try {
  const st = await withRetry(() => api('/api/publish/state'));
  logLine(`队列现状：${JSON.stringify(st.stats)}`);
} catch { /* ignore */ }
