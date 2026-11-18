/**
 * 虚拟货源网关 HTTP 服务。
 *
 * 方向说明（很容易记反，写在这里防止以后自己搞混）：
 *   · 开放平台（/api/open/*）  = **我们调闲管家**  ← packages/goofish-adapter
 *   · 虚拟货源（/goofish/*）   = **闲管家调我们**  ← 本文件
 *
 * 闲管家在「应用详情 › 货源授权信息」里配置的「接口网关」就是本服务的公网地址。
 * 应用点「上线」时，闲管家会立刻请求 查询平台信息 + 查询商户信息 做连通性校验，
 * 所以**必须先让本服务公网可达，再去点上线**。
 *
 * 本文件对数据源没有硬依赖：不传 store 时用默认的 JSON 文件存储。
 */
import http from 'node:http';
import { URL } from 'node:url';
import { genVsSign, md5, safeEqual } from './sign';
import { ERR, createHandlers, type Handlers } from './handlers';
import { getStore, seedCheckout, type GatewayStore } from './store';
import { VS_ERRORS, type VsErrorResponse } from './types';
import { loadConfig, type GatewayConfig } from './config';

export { loadConfig };
export type { GatewayConfig };

/** 闲管家官方公布的出口 IP 段（《虚拟货源-自研接入教程》文末，20251029 更新） */
export const GOOFISH_CIDRS: Array<[number, number]> = [
  ['112.74.0.0', '112.74.255.255'],
  ['120.24.0.0', '120.24.255.255'],
  ['120.78.0.0', '120.78.255.255'],
  ['120.79.0.0', '120.79.255.255'],
  ['39.108.0.0', '39.108.255.255'],
  ['47.106.0.0', '47.106.255.255'],
  ['120.77.0.0', '120.77.255.255'],
].map(([a, b]) => [ip2int(a), ip2int(b)]);

function ip2int(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + (Number(o) & 255), 0) >>> 0;
}

export function inGoofishRange(ip: string): boolean {
  // IPv6 / IPv4-mapped 形式先剥离前缀
  const v4 = ip.replace(/^::ffff:/, '');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return false;
  const n = ip2int(v4);
  return GOOFISH_CIDRS.some(([a, b]) => n >= a && n <= b);
}

// ------------------------------------------------------------------ 请求处理

/** 把任意前缀的路径归一为 /goofish/... —— 兼容「接口网关」配置成根路径或带子路径 */
export function normalizePath(rawPath: string): string {
  const i = rawPath.indexOf('/goofish/');
  if (i >= 0) return rawPath.slice(i);
  return rawPath;
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

interface Verified {
  ok: true;
}
interface Rejected {
  ok: false;
  code: number;
  msg: string;
}

/**
 * 验签。三类失败分别对应官方错误码 403 / 408 / 401。
 *
 * 顺序刻意与官方一致：先校验商户可用性（1000），再校验时间戳（408），最后验签（401）。
 * 这样排查时能一眼看出卡在哪一环，而不是所有问题都笼统地报 401。
 */
function verify(cfg: GatewayConfig, q: URLSearchParams, rawBody: string, ip: string): Verified | Rejected {
  if (cfg.ipWhitelist && !inGoofishRange(ip)) {
    return { ok: false, code: 403, msg: `访问IP不在IP白名单内：${ip}` };
  }

  const mchId = q.get('mch_id') ?? '';
  const timestamp = q.get('timestamp') ?? '';
  const sign = q.get('sign') ?? '';

  if (mchId !== cfg.mchId) {
    return { ok: false, code: 1000, msg: `商户不存在：${mchId || '(空)'}` };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > cfg.timestampTolerance) {
    return { ok: false, code: 408, msg: `时间戳已超过有效期：${timestamp}` };
  }

  const expect = genVsSign({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    mchId: cfg.mchId,
    mchSecret: cfg.mchSecret,
    timestamp: ts,
    bodyString: rawBody,
  });
  if (!sign || !safeEqual(sign.toLowerCase(), expect.toLowerCase())) {
    return { ok: false, code: 401, msg: '签名错误' };
  }
  return { ok: true };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      // 网关暴露在公网，做个上限防止被打爆内存
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体超过 2MB 上限'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 取请求来源 IP，仅用于日志审计 —— **不要**拿它做安全判断。
 *
 * ⚠️ 2026-10-06 实测结论（隧道部署场景）：
 *   向公网地址发一个带 `X-Forwarded-For: 47.106.99.78` 的请求，
 *   本函数会原样返回 47.106.99.78 —— 而 47.106.99.78 是闲管家的官方出口 IP。
 *   也就是说**任何人加一个 header 就能冒充闲管家**。
 *
 * 因此在反向代理（Cloudflare 隧道 / Nginx 等）后面，`XGJ_IP_WHITELIST` 必须保持 false，
 * 真正的安全边界只有签名（app_secret + mch_secret）。白名单只在
 * 「网关直接暴露在公网、客户端无法插入 XFF」时才成立。
 */
function clientIp(req: http.IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress ?? '';
}

export interface ServerOptions {
  config: GatewayConfig;
  store?: GatewayStore;
  /** 覆盖处理函数（高级用法：追加/替换某个路径） */
  handlers?: Handlers;
}

export function createServer(options: ServerOptions | GatewayConfig): http.Server {
  // 兼容旧签名 createServer(cfg)
  const opts: ServerOptions = 'config' in options ? options : { config: options };
  const cfg = opts.config;
  const store = opts.store ?? getStore();
  const handlers = opts.handlers ?? createHandlers(store, { appId: cfg.appId });

  return http.createServer(async (req, res) => {
    const t0 = Date.now();
    const ip = clientIp(req);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = normalizePath(url.pathname);

    // 健康检查：不需要签名，用于「网关是否公网可达」的排查
    if (path === '/__health') {
      send(res, 200, { ok: true, service: 'xgj-virtual-source-gateway', time: new Date().toISOString() });
      return;
    }

    /**
     * 请求体摘要。排查「闲管家到底传了什么参数」时，这一行是关键证据——
     * 例如它在配货源时用 keyword 搜什么、page_size 要多少、goods_type 是不是 2。
     *
     * 截断到 600 字符，避免超长 body 把日志刷爆。请求体里不含卡密（卡密是我们返回的），
     * 只有 notify_url / token 这类半敏感字段，留在本机日志里可接受。
     */
    let bodyTag = '';
    const log = (extra: string) =>
      console.log(
        `[${new Date().toISOString()}] ${req.method} ${path} ip=${ip} ${Date.now() - t0}ms ${extra}${bodyTag}`,
      );

    if (req.method !== 'POST') {
      // ⚠️ 2026-10-19 实测：闲管家「应用连通性检测」会先用 **GET** 探路径
      //   （日志里 GET /goofish/order/ → GET /goofish/order/purchase/create，逐步补全）。
      //   我们原来一律回 405，导致它判定"接口不可用"→ 真实订单根本不发过来。
      //   ⇒ 已知路径的 GET 回一个 200 的健康响应（不含任何数据），让它把检测走完。
      if (req.method === 'GET' && handlers.routes[path]) {
        send(res, 200, { code: 0, msg: 'OK', data: { method: 'POST' } });
        log('probe-ok');
        return;
      }
      send(res, 405, { code: 1, msg: 'Method Not Allowed：闲管家所有接口均为 POST' } satisfies VsErrorResponse);
      log('405');
      return;
    }

    let rawBody = '';
    try {
      rawBody = await readBody(req);
      const compact = rawBody.replace(/\s+/g, ' ').trim();
      if (cfg.logBody && compact) {
        bodyTag = ` body=${compact.length > 600 ? compact.slice(0, 600) + '…(截断)' : compact}`;
      }
    } catch (e: any) {
      send(res, 200, ERR(1, `读取请求体失败：${e.message}`) satisfies VsErrorResponse);
      log('body-error');
      return;
    }
    // 官方说明：无 body 时签名字符串用 md5("{}") 或 md5("")，两者都要能验
    if (rawBody === '') rawBody = '{}';

    const v = verify(cfg, url.searchParams, rawBody, ip);
    if (!v.ok) {
      send(res, 200, ERR(v.code, v.msg) satisfies VsErrorResponse);
      log(`reject code=${v.code} (${VS_ERRORS[v.code] ?? ''})`);
      return;
    }

    const handler = handlers.routes[path];
    if (!handler) {
      const known = handlers.unimplemented.has(path);
      send(res, 200, {
        code: 1,
        msg: known
          ? `该接口尚未对接：${path}（本网关只提供卡密链路，如需直充/调价请扩展 handlers）`
          : `未知接口路径：${path}`,
      } satisfies VsErrorResponse);
      log('unknown-path');
      return;
    }

    let body: any = {};
    try {
      body = JSON.parse(rawBody);
    } catch {
      send(res, 200, ERR(1, 'body 不是合法 JSON') satisfies VsErrorResponse);
      log('bad-json');
      return;
    }

    try {
      const out = handler(body);
      send(res, 200, out);
      const code = (out as any)?.code ?? '?';
      const extra =
        path === '/goofish/order/purchase/create' && code === 0
          ? `order=${body?.order_no} goods=${body?.goods_no} qty=${body?.buy_quantity}`
          : `code=${code}`;
      log(extra);
    } catch (e: any) {
      console.error(e);
      send(res, 200, ERR(500, `系统异常，请重试：${e.message}`) satisfies VsErrorResponse);
      log('exception');
    }
  });
}

// ------------------------------------------------------------------ 自检信息

export function configSummary(cfg: GatewayConfig, store: GatewayStore = getStore()) {
  const seed = seedCheckout(store);
  const cat = store.loadCatalog();
  return {
    port: cfg.port,
    mchId: cfg.mchId || '(未配置)',
    mchSecretMasked: cfg.mchSecret ? `${cfg.mchSecret.slice(0, 4)}…${cfg.mchSecret.slice(-4)}` : '(未配置)',
    appId: cfg.appId || '(未配置)',
    ipWhitelist: cfg.ipWhitelist,
    dataDir: store.location,
    seedCreated: seed.created,
    goods: cat.goods.map((g) => ({
      goods_no: g.goods_no,
      name: g.goods_name,
      stock: store.availableStock(g.goods_no),
    })),
  };
}
