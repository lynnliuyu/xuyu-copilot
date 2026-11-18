#!/usr/bin/env node
/**
 * SSH 反向隧道（保活版 + 远端残留会话自愈）—— 把自有服务器的
 * 127.0.0.1:<REMOTE_PORT> 转发到本机网关。
 *
 * 为什么用它替代 Cloudflare Quick Tunnel：
 *   免费 Quick Tunnel 会被 Cloudflare 回收（2026-10-08 真实事故），且**每次重启地址都变**，
 *   一变就得去闲管家重填「接口网关」。而本方案的公网地址是**固定的**：
 *     https://xgj.fmkj.top        （服务器 Caddy: handle /goofish/* → reverse_proxy 127.0.0.1:8787）
 *
 * 拓扑：
 *   闲管家 ──> xgj.fmkj.top (Caddy, 自有服务器)
 *                  └ /goofish/* ──> 127.0.0.1:8787（服务器本地）
 *                                        ▲
 *                                        │ 本脚本建立的反向隧道（本机主动连出去，不需要公网 IP）
 *                                        │
 *                          本机 Mac: xgj-gateway 127.0.0.1:8787
 *
 * 本机代码零改动：gateway / card-sync / ops-check / check-delivery 全部照旧。
 *
 * ⚠️ SSH 隧道是 TCP 转发，Caddy 看到的来源是 127.0.0.1，
 *    所以 XGJ_IP_WHITELIST 仍必须保持 false（要白名单得把网关真正搬到服务器）。
 *
 * ⚠️ 服务器侧必须在 Caddyfile 用 `handle /goofish/*`，**不能用 handle_path**
 *    （handle_path 会剥掉 /goofish 前缀，上游收不到正确路径）。
 *
 * ── ⭐ 自愈：为什么必须在重连前清「远端残留会话」
 * ssh 会话被网络打断（Broken pipe / timeout）后，**服务器上的 sshd-session 不会立刻释放端口**。
 * 于是每一次重连都报 `remote port forwarding failed for listen port N`，
 * 而脚本只是傻等退避重连 —— 2026-10-09 实测**空转 91 次、43 分钟**，
 * 期间闲管家拍单不发货、读者回复关键词收不到任何东西，平台端却都显示正常。
 * 现在检测到这个错误会先 ssh 上去把占端口的旧会话 kill 掉，再重连。
 * 判据（经验）：**端口在监听但连不通 ＝ 残留会话**，不是「没监听」。
 *
 * ── ⭐⭐ 2026-10-21 二次事故与本次加固（同一条链路的第二个坑）
 * 现象：02:28–04:39(UTC) 隧道彻底断掉 **2 小时 11 分**，重连失败 **2633 次**，
 *       而 docker ps 全程显示 `Up 43 hours`、日志里也没有任何告警级别的东西。
 * 三个根因，逐条对应下面的修改：
 *   ① 端口占用分支原本是**固定 1.5 秒**重连，等于每 3 秒往服务器打 2 条新 ssh 连接。
 *      远端 sshd 的 MaxStartups 因此开始拒绝新连接 —— **把自己的「清理 ssh」也拒了**，
 *      于是 `清理失败` 刷屏两小时，自愈机制把自己锁死。
 *      改：占用态**指数退避 + 抖动**（1.5s → 30s 封顶），清理动作限流为 ≥60 秒一次，
 *          且必须 `await` 清理结束再重连（不 await 等于自己撞自己）。
 *   ② 服务器 sshd 没设 ClientAliveInterval，客户端异常掉线后**死会话会长期占着端口**。
 *      这是根因，需要服务器侧配合（见 printServerHint 与 runbook），本脚本只能尽力自愈。
 *      改：清理命令的端口匹配从 `grep ":8787"`（子串，会误伤 :87870 之类）
 *          收紧为 `$4 ~ /:8787$/`（精确匹配监听地址末段），避免误杀无关进程。
 *   ③ 「断了」这件事**没有对外信号**。脚本只能写日志，没人看日志就等于无提示 ——
 *      而本项目自己的文档写着「网关隧道一断 = 拍单不发货且无提示」。
 *      改：连上后每 20 秒刷新心跳文件，配合 docker-compose.yml 里新增的 healthcheck，
 *          让 `docker ps` 直接显示 unhealthy（不再假装 Up）。
 *   另外：原先清理失败只打 80 字符，真正的报错原因被截掉（就是这次查不出根因的直接原因）。
 *         改为打印 ssh stderr 首行，不再截断关键信息。
 *
 * 用法：
 *   node scripts/tunnel-ssh.mjs              # 前台运行，断线自动重连
 *   node scripts/tunnel-ssh.mjs --once       # 只连一次，断了就退出（调试用）
 *
 * 多实例（同一脚本可跑多条独立隧道，互不影响）：
 *   默认实例   = 闲管家网关 8787（由 .env 驱动，行为与以往完全一致）
 *   微信实例   = TUNNEL_NAME=wechat TUNNEL_REMOTE_PORT=8899 TUNNEL_LOCAL_PORT=8899 \
 *                TUNNEL_PUBLIC_URL=https://xgj.fmkj.top/wechat node scripts/tunnel-ssh.mjs
 *   ⚠️ 之所以用「独立进程」而不是在一条隧道里加多个 -R：
 *      多转发时 `ExitOnForwardFailure=yes` 会让任一端口冲突拖垮整条隧道 ——
 *      微信侧起不来事小，把闲管家回调链路带断就是事故（拍单不发货且无提示）。
 *
 * 环境变量（写在 .env）：
 *   TUNNEL_SSH_HOST    root@150.158.3.164
 *   TUNNEL_SSH_KEY     /path/to/key.pem
 *   TUNNEL_REMOTE_PORT 8787     （服务器上监听的本地端口，与 Caddy 反代目标一致）
 *   TUNNEL_LOCAL_PORT  8787     （被转发的端口，一般不用改）
 *   TUNNEL_LOCAL_HOST  127.0.0.1（被转发的地址；**在容器里必须改成服务名**，如 gateway）
 *   TUNNEL_NAME        xgj      （仅日志标签，用于区分多实例）
 *   GOOFISH_PUBLIC_URL https://xgj.fmkj.top  （仅用于启动时打印与自检）
 *   TUNNEL_PUBLIC_URL  （优先于上面那个；多实例时用它对号入座）
 *   TUNNEL_NO_CLEAR=1  （关掉远端清理，调试用）
 *   TUNNEL_HEARTBEAT   /tmp/tunnel-heartbeat（心跳文件路径；compose healthcheck 读它的 mtime）
 *   TUNNEL_CLEAR_MIN_INTERVAL_MS  60000（两次远端清理之间至少间隔多久）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 极简 .env 读取（不引依赖） */
function readEnv(key, fallback = '') {
  if (process.env[key]) return process.env[key];
  try {
    const txt = fs.readFileSync(path.join(PROJ, '.env'), 'utf8');
    const m = txt.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm'));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* 没有 .env 就用默认值 */
  }
  return fallback;
}

const HOST = readEnv('TUNNEL_SSH_HOST');
const KEY = readEnv('TUNNEL_SSH_KEY');
const REMOTE_PORT = Number(readEnv('TUNNEL_REMOTE_PORT', '8787'));
const LOCAL_PORT = Number(readEnv('TUNNEL_LOCAL_PORT', '8787'));
/**
 * 转发目标的地址。默认 127.0.0.1（本机直跑进程时的情形）。
 * ⭐ 放进容器后必须改：容器里的 127.0.0.1 是**它自己的回环**，那里没有网关。
 *    在 compose 网络里要用服务名，例如 TUNNEL_LOCAL_HOST=gateway。
 */
const LOCAL_HOST = readEnv('TUNNEL_LOCAL_HOST', '127.0.0.1');
// ⭐ 实例名同时支持 `--name=`：这样它会出现在命令行里，外部脚本才能
//    `pkill -f "tunnel-ssh.mjs --name=xgj"` 精准杀掉某一条，而不是把别的隧道一起带走。
const NAME =
  process.argv.find((a) => a.startsWith('--name='))?.slice('--name='.length) ||
  readEnv('TUNNEL_NAME', 'xgj');
const PUBLIC_URL = readEnv('TUNNEL_PUBLIC_URL', '') || readEnv('GOOFISH_PUBLIC_URL', '');
const ONCE = process.argv.includes('--once');
const NO_CLEAR = Boolean(process.env.TUNNEL_NO_CLEAR);

// ── 加固用的常量（2026-10-21）──────────────────────────────────────────────
/** 心跳文件：连上后定期刷新 mtime，compose 的 healthcheck 只看它新不新鲜。 */
const HEARTBEAT = readEnv('TUNNEL_HEARTBEAT', '') || '/tmp/tunnel-heartbeat';
const HEARTBEAT_INTERVAL_MS = 20_000;
/** ssh 进程活过这么久还没退出，就认定隧道真的通了（ExitOnForwardFailure 会让失败立刻退出）。 */
const UP_SETTLE_MS = 3_000;
/** 两次「远端清理」之间至少间隔这么久 —— 防止清理风暴把自己挤掉。 */
const CLEAR_MIN_INTERVAL_MS = Number(readEnv('TUNNEL_CLEAR_MIN_INTERVAL_MS', '') || 60_000);
/** 端口占用态的退避：1.5s → 3s → 6s → … → 30s 封顶（替代原先的固定 1.5s）。 */
const BLOCKED_WAIT_START_MS = 1_500;
const BLOCKED_WAIT_MAX_MS = 30_000;
/** 普通失败（非端口占用）的退避：2s × 次数 → 30s 封顶（保持原行为）。 */
const FAIL_WAIT_MAX_MS = 30_000;
/** 连续多久不通就升级成「大声告警」，以及重复告警的间隔。 */
const DOWN_ALERT_AFTER_MS = 5 * 60_000;
const DOWN_ALERT_EVERY_MS = 60_000;

if (!HOST) {
  console.error('❌ 缺少 TUNNEL_SSH_HOST（在 .env 里设置，形如 root@1.2.3.4）');
  process.exit(2);
}
if (KEY && !fs.existsSync(KEY)) {
  console.error(`❌ 找不到私钥：${KEY}`);
  process.exit(2);
}

const log = (msg) =>
  console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] [${NAME}] ${msg}`);

log(`反向隧道 → ${HOST}  服务器 127.0.0.1:${REMOTE_PORT}  ⇄  ${LOCAL_HOST}:${LOCAL_PORT}`);
if (PUBLIC_URL) log(`固定公网入口：${PUBLIC_URL}`);

/** 所有 ssh 调用共用的选项 */
const SSH_OPTS = [
  '-T',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'TCPKeepAlive=yes',
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=15',
  ...(KEY ? ['-i', KEY] : []),
];

const SSH_ARGS = [
  '-N', // 不执行远程命令，只做转发
  ...SSH_OPTS,
  // 端口被占用时立刻失败，别静默挂着一个坏的转发
  '-o', 'ExitOnForwardFailure=yes',
  '-R', `${REMOTE_PORT}:${LOCAL_HOST}:${LOCAL_PORT}`,
  HOST,
];

/** 心跳文件：只更新 mtime，内容不重要。 */
function touchHeartbeat() {
  try {
    fs.writeFileSync(HEARTBEAT, String(Date.now()));
  } catch {
    /* 心跳写不进去不该拖垮隧道本身，healthcheck 那边自然会报 unhealthy */
  }
}

/**
 * 清掉服务器上占着 REMOTE_PORT 的残留会话。
 * 这是「断线后重连一直失败」的唯一原因，也是本脚本唯一的自愈点。
 *
 * ⚠️ 2026-10-21 改动：
 *   - 🐛 **修掉一个让自愈从来没生效过的 shell 语法错误**（见下面的注释）
 *   - 改成异步（原来 execFileSync 会阻塞事件循环最多 25 秒，日志与心跳全卡住）
 *   - 端口匹配收紧为「监听地址以 :PORT 结尾」，不再用子串匹配误伤无关进程
 *   - 失败时打印 stderr 首行（原来截断到 80 字符，把真正的报错原因吃掉了）
 *
 * 🐛 那个语法错误：原实现把远程脚本片段用 `.join('; ')` 拼成一行，
 *    于是 `if [ -z "$pids" ]; then echo NO_STALE; else` + `for ...` 拼出来是
 *      `if ...; then echo NO_STALE; else; for ...`
 *    —— **`else;` 在 shell 里是语法错误**（else 后面不能直接跟分号），
 *    远端立刻 `syntax error near unexpected token ';'` 退出，
 *    所以「清残留会话」这一步**从写出来那天起就没有成功执行过一次**。
 *    2026-10-09 空转 91 次/43 分钟、2026-10-21 空转 2633 次/2 小时 11 分，
 *    根因都是它 —— 而旧日志把错误信息截断到 80 字符，
 *    正好只剩下 `Command failed: ssh -T -o ServerAliveInterval=30 ...`，看不出一丝端倪。
 *    改：不再拼一行，改为直接写多行 shell 脚本（ssh 会把整段当远程命令执行），
 *        并且显式报告 STILL_BLOCKED / CLEARED，不再靠字符串里是否含 CLEARED 猜。
 */
function clearRemoteStale() {
  // 直接给多行脚本，不要用 '; ' 拼 —— 拼接正是上面那个 bug 的来源。
  const remote = `P=":${REMOTE_PORT}"
pids=$(ss -lntpH 2>/dev/null | awk -v p="$P" '$4 ~ (p "$")' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
if [ -z "$pids" ]; then
  echo NO_STALE
else
  for pid in $pids; do
    kill "$pid" 2>/dev/null && echo "KILLED $pid"
  done
  sleep 1
fi
if ss -lntp 2>/dev/null | awk -v p="$P" '$4 ~ (p "$")' | grep -q .; then
  echo STILL_BLOCKED
else
  echo CLEARED
fi
`;

  return new Promise((resolve) => {
    execFile(
      'ssh',
      [...SSH_OPTS, HOST, remote],
      { encoding: 'utf8', timeout: 25_000 },
      (err, stdout, stderr) => {
        if (err) {
          // 先把远端 stderr 打出来 —— 这次事故就是被「截断的错误信息」拖了两小时
          const detail =
            String(stderr || '').trim().split('\n')[0] ||
            String(err.message || '').split('\n')[0];
          log(`   ⚠️ 清理失败：${detail.slice(0, 200)}`);
          resolve(false);
          return;
        }
        for (const line of String(stdout).trim().split('\n')) {
          if (line.trim()) log(`   ${line.trim()}`);
        }
        resolve(String(stdout).includes('CLEARED'));
      },
    );
  });
}

/**
 * 退避 + 抖动。
 * 抖动的意义：闲管家与微信是**两个独立容器**，它们会同时重连同一台服务器。
 * 没有抖动就是同频冲击，有抖动才能错开，避免一起把远端 sshd 打到 MaxStartups。
 */
function jitter(ms) {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

let stopping = false;
let attempt = 0; // 普通失败的连续次数（用于 else 分支退避）
let blockedStreak = 0; // 「端口被残留会话占着」的连续次数（用于占用态指数退避）
let connected = false; // 当前这条 ssh 是否已经稳定建立
let downSince = 0; // 从什么时候开始连不上（0 = 现在通着）
let lastClearAt = 0; // 上次执行远端清理的时刻，用于限流
let clearRounds = 0; // 一共清过几轮，纯日志用
let lastAlertAt = 0;

if (!ONCE) {
  touchHeartbeat(); // 先写一次，免得 start_period 内 healthcheck 扑空
  const hb = setInterval(() => {
    if (connected) touchHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
  hb.unref?.();
}

function run() {
  attempt++;
  if (attempt > 1) log(`第 ${attempt} 次连接…`);
  const started = Date.now();

  // stderr 用 pipe 自己转发：既保留原始日志，又要能检测「端口被占」这个错误
  const child = spawn('ssh', SSH_ARGS, { stdio: ['ignore', 'inherit', 'pipe'] });
  let errBuf = '';

  // ssh -N 成功时是**静默**的，没有「已连接」事件。
  // 但 ExitOnForwardFailure=yes 会让失败立刻退出，所以「活过 3 秒」就是可靠的连通判据。
  const settle = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      if (!connected) log(`✅ 隧道已建立（服务器 127.0.0.1:${REMOTE_PORT}）`);
      connected = true;
      downSince = 0;
      touchHeartbeat();
    }
  }, UP_SETTLE_MS);

  child.stderr.on('data', (d) => {
    const s = d.toString();
    errBuf = (errBuf + s).slice(-4000);
    process.stderr.write(s);
  });

  child.on('exit', async (code, signal) => {
    clearTimeout(settle);
    connected = false;
    if (stopping) return;
    const lived = (Date.now() - started) / 1000;
    log(`⚠️ ssh 退出（code=${code ?? '-'} signal=${signal ?? '-'}，存活 ${Math.round(lived)}s）`);
    if (ONCE) process.exit(code ?? 1);

    if (!downSince) downSince = Date.now();

    // 连超过 1 分钟才算「稳定连接」，重置退避，免得长期运行后重连间隔一直是 30s
    if (lived > 60) {
      attempt = 0;
      blockedStreak = 0;
    }

    // ⭐ 关键自愈：端口被上一轮的死会话占着时，重连必然失败 —— 先清远端再重连
    const portBlocked = /remote port forwarding failed for listen port/.test(errBuf);
    let wait;
    if (portBlocked) {
      blockedStreak++;
      const now = Date.now();
      if (NO_CLEAR) {
        log(`⚠️ 远端 ${REMOTE_PORT} 被旧会话占着（TUNNEL_NO_CLEAR 已开，跳过清理）`);
      } else if (now - lastClearAt >= CLEAR_MIN_INTERVAL_MS) {
        // ⚠️ 必须 await：清理还没结束就重连，等于拿新连接去撞那个还没被 kill 掉的旧会话
        lastClearAt = now;
        clearRounds++;
        log(`⚠️ 远端 ${REMOTE_PORT} 被上一轮的死会话占着 → 第 ${clearRounds} 轮清理（连续第 ${blockedStreak} 次被占）`);
        await clearRemoteStale();
        if (stopping) return;
      } else {
        const ago = Math.round((now - lastClearAt) / 1000);
        log(`⚠️ 远端 ${REMOTE_PORT} 仍被占着（${ago}s 前刚清过，跳过清理，只等退避）`);
      }
      // 占用态指数退避：1.5s → 3s → 6s → … → 30s。
      // 原先是固定 1.5s，2 小时刷了 2633 次，把远端 sshd 打到拒绝新连接，自愈反而锁死。
      wait = jitter(Math.min(BLOCKED_WAIT_MAX_MS, BLOCKED_WAIT_START_MS * 2 ** (blockedStreak - 1)));
    } else {
      wait = jitter(Math.min(FAIL_WAIT_MAX_MS, 2000 * attempt)); // 退避重连，最长 30 秒
    }

    // 断超过 5 分钟就每分钟大声喊一次：这条链路断了 = 拍单不发货，不能只躺在日志里
    const downMs = Date.now() - downSince;
    if (downMs >= DOWN_ALERT_AFTER_MS && Date.now() - lastAlertAt >= DOWN_ALERT_EVERY_MS) {
      lastAlertAt = Date.now();
      log(
        `🚨 隧道已持续 ${Math.round(downMs / 60_000)} 分钟无法建立 —— ` +
          `公网 ${REMOTE_PORT} 回不到本机，闲管家回调会全部失败（拍单不发货）`,
      );
    }

    log(`${(wait / 1000).toFixed(1)} 秒后重连`);
    setTimeout(run, wait);
  });

  child.on('error', (e) => {
    clearTimeout(settle);
    connected = false;
    if (stopping) return;
    log(`⚠️ 无法启动 ssh：${e.message}`);
    if (ONCE) process.exit(1);
    setTimeout(run, 5000);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    log('收到退出信号，正在关闭隧道…');
    process.exit(0);
  });
}

run();
