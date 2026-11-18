/**
 * 公网入口看门狗 —— 保证闲管家的回调链路随时可用。
 *
 * 背景（2026-10-08 真实事故）：
 *   Cloudflare 免费 Quick Tunnel 在 05:09 被回收，cloudflared 进程还活着、
 *   容器显示 Up 42h，只是每 3 分钟重试并打印 `Unauthorized: Tunnel not found`。
 *   本机 8787 一直健康，所以只测本机的体检报了「✅ 可达」—— 假安心。
 *   8 小时后买家拍单，回调进不来，没发货，而且毫无提示。
 *
 * 现在的主链路已换成**固定地址**（SSH 反向隧道 + 自有服务器 Caddy）：
 *   闲管家 → https://xgj.fmkj.top  →  Caddy handle /goofish/*  →  127.0.0.1:8787
 *                                          ▲ 由 scripts/tunnel-ssh.mjs 建的反向隧道接过来
 *   地址不再变化，所以检查目标也改成这个固定地址（读 GOOFISH_PUBLIC_URL）。
 *
 * 检查内容（按顺序）：
 *   1. 固定公网地址是否可达，且**响应确实来自本网关**（不只看 HTTP 通不通）
 *   2. 没配 GOOFISH_PUBLIC_URL 时，回退去 docker 日志里抓 trycloudflare 地址（遗留，见 trycloudflareUrl）
 *   3. 本机网关自身是否健康
 *   4. 微信关键词链路（独立隧道、独立自愈）
 *
 * 自愈（--heal）覆盖三类故障：
 *   a. 本机网关容器没跑（Docker 重启／被误停）→ `docker compose up -d`（全量）
 *   b. 闲管家隧道不通 → 重启 tunnel-xgj 后复测
 *   c. 微信隧道不通   → 重启 tunnel-wechat 后复测
 *
 * ⚠️ 隧道自愈会**自动区分容器与进程**（见 COMPOSE_SERVICES / tunnelMode）：
 *    进了容器之后宿主机上 pgrep 找不到 tunnel-ssh.mjs，只按进程判断会静默失效。
 *
 * 退出码：0 = 正常（含自愈成功）；2 = 异常（可据此接告警）
 *
 * 用法：
 *   npx tsx scripts/watch-tunnel.ts
 *   npx tsx scripts/watch-tunnel.ts --quiet    只在异常时输出
 *   npx tsx scripts/watch-tunnel.ts --heal     发现故障就自动修复
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(PROJ, 'out', 'tunnel-state.json');
const CONTAINER = process.env.TUNNEL_CONTAINER || 'xgj-tunnel';
const QUIET = process.argv.includes('--quiet');
const LOCAL = `http://127.0.0.1:${process.env.XGJ_PORT || 8787}`;

/** 极简 .env 读取 */
function readEnv(key: string, fallback = ''): string {
  if (process.env[key]) return process.env[key];
  try {
    const m = fs.readFileSync(path.join(PROJ, '.env'), 'utf8').match(new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm'));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* 忽略 */
  }
  return fallback;
}

const PUBLIC = readEnv('GOOFISH_PUBLIC_URL').replace(/\/+$/, '');
/** --heal：发现本机网关没跑或公网入口不通时，尝试自动拉起后复测 */
const HEAL = process.argv.includes('--heal');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ⭐ 隧道的两种托管方式 —— 自愈必须两种都会。
 *
 *   container（现在）：docker compose 里的 tunnel-xgj / tunnel-wechat
 *   process  （旧）  ：launchd 直接拉起的 tunnel-ssh.mjs
 *
 * ⚠️ 判据绝不能只看 `pgrep`。隧道进了容器之后**宿主机上根本看不到那个进程**，
 *    pgrep 返回空会让自愈以为「没在跑」，然后去 pkill 一个不存在的目标 ——
 *    结果是「跑了自愈、什么也没修好，还报告成功」。这类静默失效是本项目最容易踩的坑。
 *    所以先问 compose 定义了哪些服务，再决定用哪套动作。
 */
const COMPOSE_SERVICES: Record<string, string> = {
  xgj: 'tunnel-xgj',
  wechat: 'tunnel-wechat',
};

let _services: string[] | null = null;
/** compose 文件里定义了哪些服务（只问一次） */
function composeServices(): string[] {
  if (_services) return _services;
  const cp = spawnSync('docker', ['compose', 'config', '--services'], {
    cwd: PROJ,
    encoding: 'utf8',
    timeout: 30_000,
  });
  _services =
    cp.status === 0
      ? String(cp.stdout ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  return _services;
}

/** 该实例交给谁管 */
function tunnelMode(name: string): 'container' | 'process' {
  const svc = COMPOSE_SERVICES[name];
  return svc && composeServices().includes(svc) ? 'container' : 'process';
}

const compose = (args: string[], timeout = 180_000) =>
  spawnSync('docker', ['compose', ...args], { cwd: PROJ, encoding: 'utf8', timeout });

/** 本机反向隧道是否在跑（可按实例名过滤；自动区分容器 / 进程） */
function tunnelRunning(name?: string): boolean {
  if (name && tunnelMode(name) === 'container') {
    const cp = compose(['ps', '--status', 'running', '-q', COMPOSE_SERVICES[name]], 30_000);
    return cp.status === 0 && String(cp.stdout ?? '').trim().length > 0;
  }
  const pat = name ? `tunnel-ssh.mjs --name=${name}` : 'tunnel-ssh.mjs';
  const cp = spawnSync('pgrep', ['-f', pat], { encoding: 'utf8' });
  return (cp.stdout ?? '').trim().length > 0;
}

/**
 * 拉起反向隧道。
 * · 容器模式：`docker compose up -d <服务>`（幂等）
 * · 进程模式：detached 起 tunnel-ssh.mjs（脱离本进程，父进程退出也不会被带走）
 *   ⚠️ 必须带 `--name=` —— 实例名会出现在命令行里，否则 pkill 分不清是哪条隧道。
 */
function startTunnel(inst?: { name: string; port: number; publicUrl: string }): boolean {
  if (inst && tunnelMode(inst.name) === 'container') {
    return compose(['up', '-d', COMPOSE_SERVICES[inst.name]]).status === 0;
  }
  try {
    const argv = [path.join(PROJ, 'scripts', 'tunnel-ssh.mjs')];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (inst) {
      argv.push(`--name=${inst.name}`);
      env.TUNNEL_NAME = inst.name;
      env.TUNNEL_REMOTE_PORT = String(inst.port);
      env.TUNNEL_LOCAL_PORT = String(inst.port);
      env.TUNNEL_PUBLIC_URL = inst.publicUrl;
    }
    const child = spawn(process.execPath, argv, { detached: true, stdio: 'ignore', cwd: PROJ, env });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * 只重启指定实例 —— 不是「杀掉全部」。
 * ⚠️ 原来是无差别 `pkill -f tunnel-ssh.mjs`：会把**另一条隧道一起杀掉**，而自愈只重启 8787 那条
 *    —— 结果「修好了闲管家、顺手搞死了微信」。2026-10-09 发现并修掉。
 *    容器模式下同理，只动一个服务：`docker compose restart tunnel-xgj`。
 */
function killTunnel(name?: string): void {
  if (name && tunnelMode(name) === 'container') {
    compose(['restart', COMPOSE_SERVICES[name]]);
    return;
  }
  const pat = name ? `tunnel-ssh.mjs --name=${name}` : 'tunnel-ssh.mjs';
  spawnSync('pkill', ['-f', pat], { encoding: 'utf8' });
}

/** 微信关键词链路的独立隧道（与闲管家那条互不影响） */
const WECHAT_TUNNEL = { name: 'wechat', port: 8899, publicUrl: `${PUBLIC}/wechat` };

const ts = () => new Date().toLocaleString('zh-CN', { hour12: false });

interface State {
  url?: string;
  first_seen?: string;
  last_ok?: string;
  last_fail?: string;
  fail_count?: number;
}
const readState = (): State => {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
};
const writeState = (s: State) => {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');
};

/**
 * 微信关键词链路的探针。
 * ⚠️ 故意**不带签名**去打 —— 期望被拒 **403**，403 恰好证明「请求已经打到我们自己的服务」。
 *    502 / 连不上 才是隧道断了。（这个判据比「端口在不在听」可靠得多：
 *    服务器端口被残留 sshd-session 占着时，端口在听但一律连不通。）
 */
async function probeWechat(base: string, timeoutMs = 12000): Promise<{ ok: boolean; detail: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/wechat`, { signal: ac.signal, redirect: 'follow' });
    const body = (await r.text()).slice(0, 200);
    const ok = r.status === 403 || /bad signature|signature/.test(body);
    return {
      ok,
      detail: ok
        ? `HTTP ${r.status}，响应来自本服务（验签被拒）`
        : `HTTP ${r.status}，但**响应不像来自本服务**：${body.slice(0, 80)}`,
    };
  } catch (e: any) {
    return { ok: false, detail: `连不上：${e?.cause?.code || e?.name || e?.message}` };
  } finally {
    clearTimeout(t);
  }
}

/** 判断响应是不是来自我们自己的网关 —— 只看 HTTP 通不通是不够的 */
function isOurs(body: string): boolean {
  return /闲管家|Method Not Allowed|商户不存在|goofish/.test(body);
}

async function probe(url: string, timeoutMs = 12000): Promise<{ ok: boolean; detail: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${url}/goofish/open/info`, { signal: ac.signal, redirect: 'follow' });
    const body = (await r.text()).slice(0, 200);
    const ok = isOurs(body);
    return {
      ok,
      detail: ok
        ? `HTTP ${r.status}，响应来自本网关`
        : `HTTP ${r.status}，但**响应不像来自本网关**：${body.slice(0, 80)}`,
    };
  } catch (e: any) {
    return { ok: false, detail: `连不上：${e?.cause?.code || e?.name || e?.message}` };
  } finally {
    clearTimeout(t);
  }
}

/**
 * ⚠️ 遗留回退：从 cloudflared 容器日志里抓 trycloudflare 地址。
 *    cloudflared 已于 2026-10-15 从 docker-compose.yml 移除（早被 SSH 隧道取代、
 *    且长期没在跑），所以这个分支实际走不到 —— 只在 GOOFISH_PUBLIC_URL 缺失时兜底。
 *    保留它是因为它只会「抓不到 → 报明确错误」，不会造成误判。
 */
function trycloudflareUrl(): string {
  try {
    // ⚠️ cloudflared 日志走 stderr，execFileSync 只拿 stdout → 必须合并两路
    const cp = spawnSync('docker', ['logs', CONTAINER], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const logs = `${cp.stdout ?? ''}\n${cp.stderr ?? ''}`;
    const urls = logs.match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/g) || [];
    return urls[urls.length - 1] || '';
  } catch {
    return '';
  }
}

const state = readState();
const problems: string[] = [];
const lines: string[] = [];

/** 本机网关健康探测 */
async function probeLocal(): Promise<{ ok: boolean; status: number | null }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 4000);
  try {
    const r = await fetch(`${LOCAL}/__health`, { signal: ac.signal });
    return { ok: r.ok, status: r.status };
  } catch {
    return { ok: false, status: null };
  } finally {
    clearTimeout(t);
  }
}

/**
 * 拉起整套常驻服务（Docker Compose 全量）。
 *
 * ⚠️ 不传 `--build` —— 沿用已有镜像、秒级启动。
 * 为什么是「全量」而不是只起 gateway：2026-10-13 那次是 Docker 引擎重启，
 * 网关、两条隧道、微信回复**一起**没的；只拉网关会留下另外四条静默失效的链路。
 * cloudflared 已从 compose 移除，全量 up 不会再带起任何无关服务。
 */
function startGateway(): boolean {
  try {
    return compose(['up', '-d']).status === 0;
  } catch {
    return false;
  }
}

/* ── 1. 本机网关 ── */
{
  let g = await probeLocal();

  /**
   * 自愈（本机网关）：网关容器会随 Docker 引擎重启／被误停而**静默消失** ——
   * 此时公网入口照旧 502，但现象只有「本机网关不可达」，很容易被当成隧道问题。
   * 2026-10-13 真实事故：22:07 一批容器同时退出（Docker 重启），
   * xgj-gateway 退出码 1 且未自动拉起 → 公网 502、拍单不发货。
   * 原先 `--heal` 只重启 SSH 隧道，对「网关根本没跑」这一类无能为力，故补上。
   */
  if (!g.ok && HEAL) {
    lines.push('自愈（本机网关）：网关不可达，尝试 docker compose up -d（全量）');
    if (startGateway()) {
      await sleep(6000);
      const again = await probeLocal();
      lines.push(
        `自愈（本机网关）后复测：${again.ok ? '✅ 已恢复' : '⚠️ 仍未恢复'}（HTTP ${again.status ?? '无响应'}）`,
      );
      g = again;
    } else {
      lines.push('自愈（本机网关）：启动失败（docker 不可用，或 .env 缺少必要凭证）');
    }
  }

  if (g.ok) {
    lines.push(`本机网关：✅ ${LOCAL}（HTTP ${g.status}）`);
  } else {
    problems.push(`本机网关不可达：${LOCAL} —— 买家下单后无法出卡。检查 npm run gw:ps`);
    lines.push(`本机网关：❌ ${LOCAL}`);
  }
}

/* ── 2. 公网入口 ── */
if (PUBLIC) {
  let { ok, detail } = await probe(PUBLIC);

  /**
   * 自愈：公网入口不通时，尝试重启本机的 SSH 反向隧道再复测一次。
   *
   * 为什么不做成常驻守护：launchd 在部分受限环境里注册不了
   * （实测 `Bootstrap failed: 5: Input/output error`，连最简 plist 都一样），
   * 所以退而求其次 —— 由每小时巡检来兜底重启。
   *
   * 前提：本机网关必须是健康的。本机都不健康时重启隧道没有意义，
   * 而且可能把「其实是网关挂了」误判成隧道问题。
   */
  const localOk = !problems.some((p) => p.includes('本机网关'));
  if (!ok && HEAL && localOk) {
    const wasRunning = tunnelRunning('xgj');
    lines.push(`自愈：检测到公网入口不通（${wasRunning ? '隧道进程在跑但链路不通，重启之' : '隧道进程不在'}）`);
    killTunnel('xgj');
    await sleep(1500);
    if (startTunnel()) {
      await sleep(9000);
      const again = await probe(PUBLIC);
      ok = again.ok;
      detail = again.detail;
      lines.push(`自愈后复测：${ok ? '✅ 已恢复' : '⚠️ 仍未恢复'} → ${detail}`);
    } else {
      lines.push('自愈：拉起隧道进程失败');
    }
  }

  lines.push(`公网入口：${ok ? '✅' : '⚠️'} ${PUBLIC} → ${detail}`);
  if (ok) {
    state.last_ok = ts();
    state.fail_count = 0;
  } else {
    state.last_fail = ts();
    state.fail_count = (state.fail_count ?? 0) + 1;
    problems.push(
      `公网入口不可用：${PUBLIC}\n   ${detail}\n` +
        `   管家回调进不来 → 买家拍单不会发货。\n` +
        `   排查：① 隧道容器是否在跑（npm run gw:ps，看 tunnel-xgj）\n` +
        `        ② 服务器上 ss -lntp | grep 8787 是否在监听\n` +
        `        ③ 服务器 Caddyfile 是否有 handle /goofish/* → reverse_proxy 127.0.0.1:8787`,
    );
  }
  /* ── 2b. 微信关键词链路（独立隧道、独立自愈）──
     这条在 2026-10-09 之前**完全没人管**：断了读者回复关键词拿不到任何东西，
     而公众号端照样显示发送成功 —— 比闲管家那条更隐蔽。 */
  {
    const w = await probeWechat(PUBLIC);
    if (!w.ok && HEAL && localOk) {
      const running = tunnelRunning(WECHAT_TUNNEL.name);
      lines.push(`自愈（微信）：公网入口不通（${running ? '隧道在跑但链路不通，重启之' : '隧道进程不在'}）`);
      killTunnel(WECHAT_TUNNEL.name);
      await sleep(1500);
      if (startTunnel(WECHAT_TUNNEL)) {
        await sleep(9000);
        const again = await probeWechat(PUBLIC);
        w.ok = again.ok;
        w.detail = again.detail;
        lines.push(`自愈（微信）后复测：${w.ok ? '✅ 已恢复' : '⚠️ 仍未恢复'} → ${w.detail}`);
      } else {
        lines.push('自愈（微信）：拉起隧道进程失败');
      }
    }
    lines.push(`微信关键词：${w.ok ? '✅' : '⚠️'} ${WECHAT_TUNNEL.publicUrl} → ${w.detail}`);
    if (!w.ok) {
      problems.push(
        `微信关键词链路不可用：${WECHAT_TUNNEL.publicUrl}\n   ${w.detail}\n` +
          `   读者回复关键词将**收不到任何回复**（公众号端仍显示发送成功）。\n` +
          `   排查：① 隧道容器是否在跑（npm run gw:ps，看 tunnel-wechat）\n` +
          `        ② 服务器 ss -lntp | grep 8899 —— **端口在听但连不通＝残留会话**，kill 掉那些 sshd-session\n` +
          `        ③ Caddyfile 是否有 handle /wechat* → reverse_proxy 127.0.0.1:8899`,
      );
    }
  }

  if (state.url !== PUBLIC) {
    state.url = PUBLIC;
    state.first_seen = ts();
  }
} else {
  // 兼容旧方式：直接抓 trycloudflare
  const url = trycloudflareUrl();
  if (!url) {
    lines.push('公网入口：⚠️ 未配置 GOOFISH_PUBLIC_URL，且抓不到 trycloudflare 地址');
    problems.push('既没有 GOOFISH_PUBLIC_URL，也没有可用的 trycloudflare 隧道 —— 管家无法回调');
  } else {
    const { ok, detail } = await probe(url);
    lines.push(`公网入口（trycloudflare）：${ok ? '✅' : '⚠️'} ${url} → ${detail}`);
    if (ok) {
      state.last_ok = ts();
      state.fail_count = 0;
    } else {
      state.last_fail = ts();
      state.fail_count = (state.fail_count ?? 0) + 1;
      problems.push(`公网隧道不可用：${url}\n   ${detail}`);
    }
    if (state.url && state.url !== url) {
      problems.push(
        `⚠️ 隧道地址已变更（说明 cloudflared 重启过）：\n   旧：${state.url}\n   新：${url}\n` +
          `   → 必须去闲管家重填「接口网关」`,
      );
    }
    if (state.url !== url) {
      state.url = url;
      state.first_seen = ts();
    }
  }
}

writeState(state);

if (problems.length) {
  console.error(`\n❌ 公网入口告警 · ${ts()}\n`);
  for (const p of problems) console.error('  ' + p + '\n');
  process.exit(2);
}

if (!QUIET) {
  console.log(`\n✅ 回调链路正常 · ${ts()}`);
  for (const l of lines) console.log('  ' + l);
  if (PUBLIC) console.log('  （闲管家「接口网关」应填：' + PUBLIC + '）');
} else {
  console.log(`✅ 回调链路正常（${ts()}）`);
}
