/**
 * 管理端的启动保障与调用封装（纯 JS，供 .mjs / .ts 脚本共用）。
 *
 * 解决什么问题：
 *   后台管理端（127.0.0.1:8790）是一个**独立的本机进程**，所有流水线脚本
 *   （发布 / 导入 / 出图 / 改价）都要调它的 API。忘了起它时，
 *   旧的表现是 `fetch failed`（ECONNREFUSED），看起来像"网络问题"或"代码坏了"，
 *   实际只是没起进程 —— 极容易误判。
 *
 * 为什么不做进 docker-compose：
 *   管理端依赖**本机已装的 Chrome**（无头截图出商品图，路径是 macOS 的）和
 *   **ssh/scp + 本机私钥**（传图床）。塞进 Linux 容器要另装 Chromium 与 openssh、
 *   还要把私钥挂进去，比它解决的问题更重。所以改成「自动拉起 + 报错说人话」。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:8790';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 管理端是否在线（超时 3s，避免脚本启动时被卡住） */
export async function isAdminUp(timeoutMs = 3000) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(`${ADMIN_URL}/api/publish/state`, { signal: ac.signal, cache: 'no-store' });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * 确保管理端在线：不在线就后台拉起并等它就绪。
 * @returns true = 可用；false = 拉起失败（调用方应给出明确指引后退出）
 */
export async function ensureAdminUp({ waitMs = 25_000, quiet = false } = {}) {
  if (await isAdminUp()) return true;

  if (!quiet) console.log(`管理端未运行，自动拉起（${ADMIN_URL}）…`);
  const child = spawn('npm', ['run', 'admin'], {
    cwd: PROJ,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref(); // 让它脱离本脚本，脚本退出后继续服务

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    if (await isAdminUp(1500)) {
      if (!quiet) console.log('管理端已就绪。\n');
      return true;
    }
  }

  console.error(
    `\n❌ 管理端启动失败或超时（${ADMIN_URL}）。\n` +
    `   手动排查：npm run admin\n` +
    `   端口占用时先停掉旧实例：lsof -nP -iTCP:8790 -sTCP:LISTEN\n`,
  );
  return false;
}

/** 读取发布队列快照 */
export async function adminState() {
  const r = await fetch(`${ADMIN_URL}/api/publish/state`, { cache: 'no-store' });
  return r.json();
}

/** 调 /api/pipeline/<action> */
export async function pipeline(action, body) {
  const r = await fetch(`${ADMIN_URL}/api/pipeline/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
}
