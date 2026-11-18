/**
 * 网关配置：**零 npm 依赖**，只读环境变量。
 *
 * 为什么不用 dotenv：这个包要能被打包成单独一个 JS 文件跑在最小镜像里，
 * 运行时依赖越少越好。Docker 部署时变量由 compose 注入，本机开发时
 * 下面的极简 .env 解析已经够用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 极简 .env 解析：KEY=VALUE、# 注释、可选的引号。已存在的环境变量优先，不覆盖。 */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/**
 * 依次尝试包目录与当前工作目录的 .env；已注入的变量不会被覆盖。
 *
 * ⚠️ 只读一次。`opt()` 会被每个请求调用（例如查询平台信息要 app_id），
 *    每次都去 stat/read 两个 .env 文件是白白的磁盘 IO。
 *    环境变量本身仍然是每次现读的，所以运行时改动依旧生效。
 */
let envLoaded = false;
export function loadEnvFiles(): void {
  if (envLoaded) return;
  envLoaded = true;
  loadDotEnv(path.join(PKG_ROOT, '.env'));
  loadDotEnv(path.resolve(process.cwd(), '.env'));
}

export function opt(key: string, fallback = ''): string {
  loadEnvFiles();
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

export function bool(key: string, fallback: boolean): boolean {
  const v = opt(key);
  if (!v) return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

export interface GatewayConfig {
  port: number;
  /** 货源方自定义的商户号（填进闲管家「货源授权信息 › AppKey」） */
  mchId: string;
  /** 货源方自定义的对接密钥（填进「货源授权信息 › AppSecret」） */
  mchSecret: string;
  /** 闲管家应用概况里的 AppKey，用于验签 */
  appId: string;
  appSecret: string;
  /** 是否按官方 IP 段白名单校验。反代/隧道后面必须 false（XFF 可伪造） */
  ipWhitelist: boolean;
  /** 时间戳容差（秒） */
  timestampTolerance: number;
  /** 单位：每条日志是否附带请求体摘要 */
  logBody: boolean;
}

export function loadConfig(): GatewayConfig {
  return {
    port: Number(opt('XGJ_PORT', '8787')) || 8787,
    mchId: opt('XGJ_MCH_ID'),
    mchSecret: opt('XGJ_MCH_SECRET'),
    appId: opt('GOOFISH_APP_KEY'),
    appSecret: opt('GOOFISH_APP_SECRET'),
    ipWhitelist: bool('XGJ_IP_WHITELIST', false),
    timestampTolerance: Number(opt('XGJ_TIMESTAMP_TOLERANCE', '300')) || 300,
    logBody: bool('XGJ_LOG_BODY', true),
  };
}

/** 配置是否完整 —— 用于启动自检，缺项直接退出而不是等到第一次请求才报 401 */
export function configProblems(cfg: GatewayConfig): string[] {
  const out: string[] = [];
  if (!cfg.mchId) out.push('缺少 XGJ_MCH_ID（货源方自定义的商户号）');
  if (!cfg.mchSecret) out.push('缺少 XGJ_MCH_SECRET（货源方自定义的对接密钥）');
  if (!cfg.appId) out.push('缺少 GOOFISH_APP_KEY（闲管家应用概况里的 AppKey）');
  if (!cfg.appSecret) out.push('缺少 GOOFISH_APP_SECRET（闲管家应用概况里的 AppSecret）');
  return out;
}
