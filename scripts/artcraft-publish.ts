#!/usr/bin/env node
/**
 * ArtCraft 批量上架器（受控滴灌）。
 *
 * 为什么单独写一个而不直接用 drip-publish.mjs：
 *   drip-publish 从整个 `software` 类目里挑「下一个 ready」，会混进**别的**软件资源；
 *   这里只发**指定的 14 条 ArtCraft**，顺序、范围都可预期。
 *
 * 安全设计（对齐项目铁律）：
 *   · 发布**只走服务端** `/api/pipeline/publish.run` —— 服务端的 300s 节流 + 体检闸门
 *     是唯一权威；本地不自己算间隔（拿到 RATE_LIMIT 就按服务端给的 wait_ms 等）。
 *   · 每条发布后等 75s 再**反查真实状态**：只认 `product_status=22 && item_id>0`。
 *   · 连续 2 条「状态=21 且 item_id=0」（卡草稿）→ 判定为账号级上限，**立即熔断**，
 *     不再往下刷（继续发只会把商品全刷成草稿并加重风控）。
 *
 * 用法：
 *   npx tsx scripts/artcraft-publish.ts                发全部（跳过已成功的）
 *   npx tsx scripts/artcraft-publish.ts --only BD-X    只发指定 code（可多个）
 *   npx tsx scripts/artcraft-publish.ts --dry          只打印计划
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProduct } from '../packages/goofish-adapter/src/api';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = 'http://127.0.0.1:8790';
const LOG = path.join(ROOT, 'out', 'artcraft-publish.log');

const ALL_CODES = [
  'BD-ARTCRAFT', 'BD-PHOTOCRAFT', 'BD-PDFCRAFT', 'BD-LIGHTCRAFT', 'BD-WORDCRAFT',
  'BD-VECTORCRAFT', 'BD-EFFECTCRAFT', 'BD-CADCRAFT', 'BD-DESIGNCRAFT', 'BD-DECKCRAFT',
  'BD-SOUNDCRAFT', 'BD-FIGCRAFT', 'BD-CRAFT-LAUNCHER', 'BD-ARTCRAFT-FULLSET',
];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const DRY = has('--dry');
const ONLY: string[] = [];
argv.forEach((a, i) => { if (a === '--only' && argv[i + 1]) ONLY.push(argv[i + 1].toUpperCase()); });

const SYNC_WAIT_SEC = 75;       // 发布后等异步落地
const STUCK_STREAK_LIMIT = 2;   // 连续卡草稿熔断阈值

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const logLine = (s) => {
  const line = `[${stamp()}] ${s}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* 日志失败不影响发布 */ }
};

async function post(action: string, body: any) {
  const r = await fetch(`${B}/api/pipeline/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  return r.json();
}

async function main() {
  const listings: Record<string, any> = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'drafts', '.listings.json'), 'utf8')); }
    catch { return {}; }
  })();

  let codes = ONLY.length ? ONLY : ALL_CODES;
  if (!ONLY.length) {
    codes = codes.filter((c) => {
      const st = listings[c]?.state;
      return st !== 'on_sale';      // 已在售的跳过（金丝雀已成功的那条）
    });
  }

  logLine(`════ ArtCraft 批量上架：计划 ${codes.length} 条 ════`);
  codes.forEach((c) => logLine(`   ${c}  (台账 state=${listings[c]?.state ?? '未发布'})`));
  if (DRY) { logLine('（--dry，未发任何请求）'); return; }

  let stuckStreak = 0;
  let ok = 0;
  const results: Array<{ code: string; state: string; pid?: number; item_id?: number }> = [];

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    logLine(`── [${i + 1}/${codes.length}] ${code} ──`);

    // 1) 提交（服务端节流 + 体检）
    let res: any;
    for (let attempt = 0; attempt < 12; attempt++) {
      res = await post('publish.run', { code, confirm: true });
      if (res?.code === 'RATE_LIMIT' && res.wait_ms) {
        const w = Math.ceil(Number(res.wait_ms) / 1000) + 3;
        logLine(`   ⏳ 服务端节流，等 ${w}s 再提交`);
        await sleep(w * 1000);
        continue;
      }
      break;
    }

    if (!res?.ok) {
      logLine(`   ❌ 提交未成功：${res?.code ?? '?'} ${String(res?.message ?? '').slice(0, 150)}`);
      // 提交层面失败不算「卡草稿」，但仍要处理已生成的 product_id
    } else {
      logLine(`   ✅ 已提交 product_id=${res.product_id} state=${res.state_label ?? res.state}`);
    }

    const pid = Number(res?.product_id ?? 0);

    // 2) 等异步落地后反查真实状态
    if (pid) {
      await sleep(SYNC_WAIT_SEC * 1000);
      let st = 0, itemId = 0, shops = 0;
      try {
        const d: any = await getProduct(pid);
        st = Number(d?.product_status ?? 0);
        shops = (d?.publish_shop ?? []).length;
        itemId = Number(d?.publish_shop?.[0]?.item_id ?? 0);
      } catch (e: any) {
        logLine(`   ⚠️ 反查失败：${String(e?.message ?? e).slice(0, 100)}`);
      }
      const verified = st === 22 && itemId > 0;
      logLine(`   核验：product_status=${st} item_id=${itemId} publish_shop=${shops} → ${verified ? '✅ 真实在售' : '❌ 未落地'}`);
      results.push({ code, state: verified ? 'on_sale' : String(st), pid, item_id: itemId });

      // ⭐ 核验通过就**回写台账**为 on_sale。
      //    为什么必须做：publish.run 只把 state 写成提交时刻的 pending_review，
      //    若脚本中途重启，过滤条件（跳过 on_sale）会失效 → **重复上架**同一商品。
      if (verified) {
        try {
          const lp = path.join(ROOT, 'drafts', '.listings.json');
          const cur = JSON.parse(fs.readFileSync(lp, 'utf8'));
          cur[code] = {
            ...(cur[code] ?? {}),
            product_id: pid,
            state: 'on_sale',
            item_id: itemId,
            updated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
          };
          const tmp = `${lp}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(cur, null, 2));
          fs.renameSync(tmp, lp);
        } catch (e: any) {
          logLine(`   ⚠️ 台账回写失败（不影响上架）：${String(e?.message ?? e).slice(0, 80)}`);
        }
      }

      if (verified) { ok++; stuckStreak = 0; }
      else if (st === 21 && itemId === 0) {
        stuckStreak++;
        logLine(`   ⚠️ 卡草稿（连续 ${stuckStreak}/${STUCK_STREAK_LIMIT}）`);
        if (stuckStreak >= STUCK_STREAK_LIMIT) {
          logLine(`🛑 连续卡草稿达阈值 → 判定账号级上限，熔断停止，剩余 ${codes.length - i - 1} 条未发`);
          break;
        }
      } else { stuckStreak = 0; }
    }
  }

  logLine(`════ 结束：成功 ${ok} / 计划 ${codes.length} ════`);
  fs.writeFileSync(path.join(ROOT, 'out', 'artcraft-publish-result.json'),
    JSON.stringify(results, null, 2));
  console.log('结果已写 out/artcraft-publish-result.json');
}

main().catch((e) => { logLine(`💥 崩溃：${e?.stack ?? e}`); process.exit(1); });
