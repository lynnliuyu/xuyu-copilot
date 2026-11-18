#!/usr/bin/env node
/**
 * 发布「待发布队列」（`/api/publish/state` 里 status === 'ready' 的那些草稿）。
 *
 * ── 为什么再写一个（与另外两个的分工）
 *   · `drip-publish.mjs`      —— 只处理「从未发布过」且走它自己的队列逻辑
 *   · `republish-stuck.ts`    —— 只处理**台账里已有 product_id 但线上仍是草稿**的
 *   · 本脚本                  —— 处理后台页面上那个「待发布」队列（有草稿、无阻塞项、
 *                               台账里还没有 product_id），是用户点「发布」的那条路
 *
 * ── 关键设计：**一切经过服务端闸门**
 * 本脚本不直接调闲管家接口，而是 POST `/api/pipeline/publish.run`。
 * 好处是节流（每 `XGJ_PUBLISH_MIN_INTERVAL` 秒一个）与体检（文字 + 图片）
 * 全部由服务端强制 —— 命令行绕不过去。2026-10-08 的批量下架就是因为
 * 「客户端自己控制节奏」而没人拦得住。
 *
 * ── 可断点续跑
 * 每轮**重新拉一次状态**、取当前第一个 ready 的来发。所以：
 *   · 中断后直接再跑一次即可接着发（已发出去的已经不是 ready 了）
 *   · 同一时刻只有一份在跑也不会重复发（发了之后状态就变了）
 *
 * ── 用法
 *   npm run publish:queue                    # 发到没得发为止（受服务端节流，很慢）
 *   npm run publish:queue -- --limit 20      # 最多发 20 个
 *   npm run publish:queue -- --dry           # 只看要发什么，不提交
 *   npm run publish:queue -- --codes BD-X,BD-Y
 *   npm run publish:queue -- --recreate      # ⭐ 换店铺时必加（新建商品）
 *
 * ── ⚠️⚠️ `--recreate`：换店铺必须新建，不能靠编辑
 * 队列里可能有**台账已有 product_id** 的商品（例如 2026-10-08 16:01 那批卡草稿的）。
 * 它们属于旧店铺 —— 若直接重发，会走 `product/edit`，而
 * `product/edit` 对 `publish_shop` 是**追加语义**：detail 里会多出一条店铺记录，
 * 之后 publish 被拒「每个商品只能发布1个闲鱼店铺」。
 * （已实测踩到。所以本脚本默认**拒绝**这类商品，必须显式 `--recreate` 才继续。）
 *
 * ⚠️ 服务端节流默认 300 秒/个。发 180 个 ≈ 15 小时 —— 这是**刻意的**：
 *    闲鱼对短时间集中上架有风控，2026-10-08 用 20 秒间隔发了 93 个，
 *    16:01 被一次性下架 405 个在售商品。不要为了快而改 XGJ_PUBLISH_MIN_INTERVAL。
 */
import fs from 'node:fs';
import path from 'node:path';

const ADMIN = process.env.ADMIN_URL || 'http://127.0.0.1:8790';

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string, dft: number) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dft;
};

const DRY = has('--dry');
/** 新建商品（换店铺时必用）。见文件头说明：edit 的 publish_shop 是追加语义。 */
const RECREATE = has('--recreate');
const LIMIT = has('--all') ? Number.MAX_SAFE_INTEGER : Math.max(1, val('--limit', 100000));
const ONLY = (() => {
  const i = argv.indexOf('--codes');
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]).split(',').map((s) => s.trim()).filter(Boolean) : [];
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const line = (s = '') => console.log(`[${stamp()}] ${s}`);
const b = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${ADMIN}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await r.json()) as T;
}

type Res = {
  id: string;
  display_name?: string;
  name?: string;
  draft_code?: string | null;
  status: string;
  preflight?: { blocked: number; warned: number } | null;
  exclusion?: unknown;
  /** 台账记录（有 product_id = 已在旧店铺建过商品） */
  listing?: { product_id?: number; state?: string } | null;
};

async function readyList(): Promise<{ list: Res[]; guard: any; stats: any }> {
  const st: any = await api('/api/publish/state');
  let list: Res[] = (st.resources || []).filter((r: Res) => r.status === 'ready' && r.draft_code);
  if (ONLY.length) list = list.filter((r) => r.draft_code && ONLY.includes(r.draft_code));
  return { list, guard: st.guard, stats: st.stats };
}

/* ------------------------------------------------------------------ 单实例锁 */

/**
 * 同一时刻只允许一份在跑。
 * 为什么需要：两个进程并发时，都可能在「拉状态」那一刻看到同一个 ready 项，
 * 各自提交一次 —— 在 `--recreate` 模式下会**多建一个商品**。
 * 锁文件在 `out/publish-queue.lock`，进程退出时删除；超过 30 分钟视为陈旧锁。
 */
const LOCK = path.join(process.cwd(), 'out', 'publish-queue.lock');

function acquireLock(): boolean {
  try {
    const st = fs.statSync(LOCK);
    if (Date.now() - st.mtimeMs < 30 * 60 * 1000) {
      const pid = fs.readFileSync(LOCK, 'utf8').trim();
      // 进程还活着就拒绝；已死则接管（陈旧锁）
      let alive = false;
      try {
        process.kill(Number(pid), 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive) {
        console.error(red(`❌ 已有一份发布任务在跑（PID ${pid}）。`));
        console.error(dim('   并发跑会把同一个草稿发两次（--recreate 下会多建商品）。'));
        console.error(dim(`   确实要强制接管：删除 ${LOCK}`));
        return false;
      }
    }
  } catch {
    /* 没有锁文件 = 可以跑 */
  }
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, String(process.pid));
  const release = () => {
    try {
      if (fs.readFileSync(LOCK, 'utf8').trim() === String(process.pid)) fs.rmSync(LOCK, { force: true });
    } catch {
      /* ignore */
    }
  };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
  return true;
}

if (!DRY && !acquireLock()) process.exit(1);

/* ------------------------------------------------------------------ 主流程 */

console.log('');
console.log(b('══════ 发布「待发布队列」══════'));

let initial: Awaited<ReturnType<typeof readyList>>;
try {
  initial = await readyList();
} catch (e: any) {
  console.error(red(`❌ 连不上管理端 ${ADMIN} —— 先跑 npm run admin`));
  console.error(dim(`   ${String(e?.message ?? e)}`));
  process.exit(1);
}

const interval = initial.guard?.min_interval_sec ?? 300;
const total = Math.min(initial.list.length, LIMIT);
console.log(`  待发布 ${b(String(initial.list.length))} 个　本次最多发 ${total} 个`);
console.log(`  服务端节流 ${b(String(interval))} 秒/个 → 预计约 ${(total * interval / 3600).toFixed(1)} 小时`);
console.log(`  模式：${RECREATE ? yellow('新建商品（--recreate）') : dim('复用台账里的 product_id')}`);
console.log(`  ${dim('体检与节流都由服务端强制，本脚本绕不过去')}`);

/* ⭐ 安全闸：台账里已有 product_id 的（即旧店铺已建过商品），
      直接重发会走 product/edit，而它对 publish_shop 是**追加语义** ——
      会把商品搞成「两条店铺记录」，之后 publish 必被拒。
      换店铺必须 --recreate。 */
const withPid = initial.list.filter((r) => r.listing?.product_id);
if (withPid.length && !RECREATE) {
  console.log('');
  line(red(`⛔ ${withPid.length} 个商品在台账里已有 product_id（属于旧店铺）。`));
  line(dim('   直接重发会走 product/edit —— 而它对 publish_shop 是**追加语义**，'));
  line(dim('   会在商品上多挂一条店铺记录，之后 publish 会被拒绝「每个商品只能发布1个闲鱼店铺」。'));
  line(dim('   （2026-10-08 已实测踩到，商品只能删掉重来。）'));
  console.log('');
  line(`   换店铺请加 ${b('--recreate')}：会为新店铺**新建**商品，旧商品留在原店铺（已封控可忽略）。`);
  line(`   例：${b('npm run publish:queue -- --recreate --limit 20')}`);
  console.log('');
  process.exit(1);
}
if (RECREATE) {
  console.log('');
  line(yellow(`⚠️ --recreate：将为这 ${initial.list.length} 个商品**新建**闲管家商品。`));
  line(dim('   旧商品仍留在原店铺（顺和服饰平价超市已封控，忽略即可）。台账里的 product_id 会被新值覆盖。'));
  console.log('');
}
console.log('');

if (DRY) {
  line(dim('【dry-run】只列出将要发布的，不提交'));
  for (const r of initial.list.slice(0, total)) {
    const pf = r.preflight ? `体检 ${r.preflight.blocked ? red('⛔' + r.preflight.blocked) : green('✅')}` : dim('未体检');
    console.log(`    ${String(r.draft_code).padEnd(16)} ${String(r.display_name ?? r.name).slice(0, 34).padEnd(36)} ${pf}`);
  }
  console.log('');
  console.log(dim('  去掉 --dry 即真正开始发布（会按服务端节流一个一个来）'));
  process.exit(0);
}

let published = 0;
let blocked = 0;
let failed = 0;
let consecutiveFail = 0;

// 每轮都重新拉状态 —— 天然可断点续跑，也不会重复发
while (published + blocked + failed < LIMIT) {
  let cur: Awaited<ReturnType<typeof readyList>>;
  try {
    cur = await readyList();
  } catch (e: any) {
    line(red(`拉取状态失败：${String(e?.message ?? e).slice(0, 90)}　30 秒后重试`));
    await sleep(30_000);
    continue;
  }

  const next = cur.list[0];
  if (!next) {
    line(green('✅ 待发布队列已清空'));
    break;
  }

  const code = next.draft_code as string;
  const n = published + blocked + failed + 1;
  const name = String(next.display_name ?? next.name ?? '').slice(0, 30);

  let out: any;
  try {
    out = await api('/api/pipeline/publish.run', { code, confirm: true, ...(RECREATE ? { recreate: true } : {}) });
  } catch (e: any) {
    out = { ok: false, error: String(e?.message ?? e) };
  }

  if (out?.ok) {
    published++;
    consecutiveFail = 0;
    line(`[${n}] ${green('已提交')} ${code.padEnd(16)} ${name}　product_id=${out.product_id}　（累计 ${published}）`);
    // 服务端已经占掉名额，这里按节流间隔等，避免无谓的空转请求
    await sleep((cur.guard?.min_interval_sec ?? interval) * 1000 + 2000);
    continue;
  }

  if (out?.code === 'RATE_LIMIT') {
    const wait = Math.max(1000, Number(out.wait_ms) || 0) + 2000;
    line(dim(`[${n}] 节流等待 ${Math.ceil(wait / 1000)} 秒后重试 ${code}`));
    await sleep(wait);
    // ⚠️ 等待期间这个草稿可能已经被发出去了（另一次运行、或后台手工点了发布）。
    //    不复核就重试的话，--recreate 模式下会**多建一个商品**。所以先看一眼。
    try {
      const again = await readyList();
      if (!again.list.some((r) => r.draft_code === code)) {
        line(dim(`[${n}] ${code} 已不在待发布队列（多半已被发出），跳过`));
      }
    } catch {
      /* 拉不到就当没发出去，照常重试 */
    }
    continue; // 不计数：重试同一个，或由外层取下一个
  }

  if (out?.code === 'PREFLIGHT_BLOCKED') {
    blocked++;
    const first = String((out.preflight?.block || [])[0] ?? '').split('\n')[0].slice(0, 70);
    line(`[${n}] ${yellow('⛔ 体检拦截')} ${code.padEnd(16)} ${name}　${first}`);
    line(dim(`      → 去后台 http://127.0.0.1:8790/#preflight 看详情，并考虑「排除」掉`));
    continue;
  }

  if (out?.code === 'EXCLUDED') {
    blocked++;
    line(`[${n}] ${dim('已排除，跳过')} ${code}`);
    continue;
  }

  failed++;
  consecutiveFail++;
  line(`[${n}] ${red('失败')} ${code.padEnd(16)} ${String(out?.error ?? '未知错误').slice(0, 90)}`);
  // 典型：走了 edit 路径（未加 --recreate），或上架被拒
  if (String(out?.error ?? '').includes('未完成上架')) {
    line(dim('      → 这类商品多半在旧店铺已有商品记录。换店铺请加 --recreate 新建。'));
  }
  if (out?.retry_hint) line(dim(`      → ${String(out.retry_hint).slice(0, 110)}`));

  // 连续失败多半是账号级问题（配额 / 封控 / 凭证），继续发只会更糟
  if (consecutiveFail >= 5) {
    console.log('');
    line(red(`⛔ 连续失败 ${consecutiveFail} 个，已熔断 —— 这更像是账号级问题，不是单个商品的问题。`));
    line(dim('   建议：① 去闲管家后台看「失败原因」列；② npm run gf:shop 看店铺是否仍授权'));
    break;
  }
  await sleep(5000);
}

console.log('');
console.log(b('══════ 本次结果 ══════'));
console.log(`  已提交 ${green(String(published))} 个　体检拦截 ${yellow(String(blocked))} 个　失败 ${red(String(failed))} 个`);
console.log(dim('  上架是异步的，稍后到后台点「同步状态」核对真实结果（只看 item_id > 0）。'));
console.log('');
