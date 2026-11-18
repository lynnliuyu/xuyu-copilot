import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CACHE } from './xgj-web-runtime.mjs';

export const SESSION = CACHE + 'session.json';
const ORIGIN = 'https://api2.goofish.pro';
const LOGIN = new Set(['/v1/user/login/qrcode/create', '/v1/user/login/qrcode/check', '/v1/user/login/token/create']);
const AUTH_ERRORS = new Set([61, 401, 2011]);
const SAVE_PATH = '/v1/kami/consign/save';
const encode = value => encodeURIComponent(value).replaceAll('%20', '+');
export function formQuery(object) {
  return Object.entries(object).map(([key, value]) => Array.isArray(value)
    ? value.map(v => `${key}%5B%5D=${encode(v)}`).join('&')
    : `${key}=${value == null ? '' : encode(value)}`).filter(Boolean).join('&');
}
export class WebApiError extends Error {
  constructor(code, auth = false) {
    super(auth ? '闲管家登录已失效，请执行 consign:api login 重新扫码' : `闲管家接口拒绝请求（code=${code}）`);
    this.code = code; this.auth = auth;
  }
}
export async function saveSession(accessToken, path = SESSION) {
  if (typeof accessToken !== 'string' || !accessToken || /[\r\n]/.test(accessToken)) throw new Error('登录接口未返回有效 access_token');
  await mkdir(CACHE, { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomUUID();
  let file;
  try {
    file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(JSON.stringify({ access_token: accessToken, saved_at: new Date().toISOString() }));
    await file.close(); file = null;
    await rename(temp, path);
  } finally { if (file) await file.close(); await unlink(temp).catch(() => {}); }
}
export async function readSession(path = SESSION) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('登录凭证文件必须归当前用户所有，权限为 600');
    const data = JSON.parse(await handle.readFile('utf8'));
    if (typeof data.access_token !== 'string' || !data.access_token || /[\r\n]/.test(data.access_token)) throw new Error('登录凭证格式错误');
    return data.access_token;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('尚未登录：执行 npm run consign:api -- login');
    throw error;
  } finally { if (handle) await handle.close(); }
}

/** Only shipping configuration + its login endpoints. No order/publish/refund calls. */
export class XgjWebClient {
  #token;
  #runtime;
  #fetch;
  #tail = Promise.resolve();
  #last = 0;
  #allowed = () => true;
  constructor({ runtime, token = '', fetchImpl = fetch, minInterval = 300, allowSave = true }) {
    this.#runtime = runtime; this.#token = token; this.#fetch = fetchImpl;
    this.minInterval = minInterval;
    // Read-only mode: `/v1/kami/consign/save` is unreachable, not merely unused.
    if (!allowSave) this.#allowed = (f) => f !== SAVE_PATH;
  }
  async #request(path, params, { method = 'POST', encrypted = false } = {}) {
    if (!this.#allowed(path)) throw new Error('当前为只读模式，禁止调用写接口');
    const job = async () => {
      const interval = path === SAVE_PATH ? Math.max(3500, this.minInterval) : this.minInterval;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, interval - (Date.now() - this.#last))));
      this.#last = Date.now();
      const isLogin = LOGIN.has(path);
      if (!isLogin && !this.#token) throw new WebApiError(401, true);
      const query = formQuery({ channel: 1, version: '3.71.1', ...(method === 'GET' ? params : {}) });
      const plain = method === 'GET' ? '' : JSON.stringify(params);
      const body = encrypted ? this.#runtime.aes256EcbEncryptWithDefaultKey(plain) : plain;
      const signature = this.#runtime.httpSinWithKey(path, query, method, body, Number(encrypted));
      if (typeof signature !== 'string' || !signature.startsWith('key=') || !signature.includes(';signature=')) throw new Error('官方运行库未生成有效请求签名');
      const headers = { 'Content-Type': 'application/json;charset=utf-8', 'X-Content-Security': signature };
      if (this.#token && !isLogin) headers.Authorization = this.#token;
      let response;
      try {
        response = await this.#fetch(ORIGIN + path + '?' + query, {
          method, headers, ...(method === 'POST' ? { body } : {}),
          redirect: 'error', signal: AbortSignal.timeout(20000),
        });
      } catch { throw new Error('闲管家网络请求失败或超时；未自动重试'); }
      if (!response.ok) throw new Error(`闲管家 HTTP ${response.status}；未自动重试`);
      let raw = await response.text();
      if (encrypted) {
        try { raw = this.#runtime.aes256EcbDecryptWithDefaultKey(raw) || raw; }
        catch { throw new Error('闲管家响应解密失败'); }
      }
      let result;
      try { result = JSON.parse(raw); } catch { throw new Error('闲管家返回非 JSON 响应'); }
      const code = result.status ?? result.code;
      if (AUTH_ERRORS.has(Number(code))) { this.#token = ''; throw new WebApiError(Number(code), true); }
      if (code !== 0 && code !== 200) throw new WebApiError(Number(code));
      return result.data;
    };
    const result = this.#tail.then(job);
    this.#tail = result.catch(() => {});
    return result;
  }
  createLoginQr() { return this.#request('/v1/user/login/qrcode/create', { login_way: 3, qrcode_scene: 'auth_login' }, { encrypted: true }); }
  checkLoginQr(qrcode_token) {
    if (typeof qrcode_token !== 'string' || !qrcode_token) throw new Error('缺少扫码 token');
    return this.#request('/v1/user/login/qrcode/check', { qrcode_token }, { encrypted: true });
  }
  async finishLogin(login_token) {
    if (typeof login_token !== 'string' || !login_token) throw new Error('缺少登录 token');
    const result = await this.#request('/v1/user/login/token/create', { login_token, login_way: 3, device_id: '' }, { encrypted: true });
    if (typeof result?.access_token !== 'string' || !result.access_token) throw new Error('登录接口未返回 access_token');
    this.#token = result.access_token;
    return result.access_token;
  }
  info(productId, sku = 0) {
    if (!Number.isSafeInteger(productId) || productId <= 0 || !Number.isSafeInteger(sku) || sku < 0) throw new Error('商品 ID 或规格 ID 不合法');
    return this.#request('/v1/kami/consign/info', { send_type: 1, product_id: productId, product_sku: sku });
  }
  source(appId, code) {
    if (!Number.isSafeInteger(appId) || appId <= 0 || typeof code !== 'string' || !code) throw new Error('货源查询参数不合法');
    return this.#request('/api/seller/product/virtual/goods/list', { app_id: appId, goods_type: 2, keyword: code }, { method: 'GET' });
  }
  /** Single-product guarded save; dry-run unless apply is explicitly true.
   * No caller in the CLI enables apply. Implemented for later authorized integration.
   */
  async saveSingle(payload, { before, apply = false } = {}) {
    if (!payload || !Array.isArray(payload.product_id) || payload.product_id.length !== 1
        || !Array.isArray(payload.product_list) || payload.product_list.length !== 1
        || payload.kind_way !== 4 || payload.status !== 1 || payload.send_type !== 1
        || payload.ex_url_status !== 0 || Number(payload.adjust_price?.status) === 1
        || typeof payload.goods_no !== 'string' || !payload.goods_no) throw new Error('只支持预演过的单商品直接货源配置');
    const id = payload.product_id[0];
    const current = await this.info(id, payload.product_sku || 0);
    if (!before || JSON.stringify(current) !== JSON.stringify(before)) throw new Error('线上配置与预演快照不一致，停止保存');
    const product = current.product, row = payload.product_list[0], existing = current.consign;
    if (!product || !existing || Number(product.product_id) !== id || row.product_id !== id
        || !(Number(product.item_id) > 0) || row.item_id !== product.item_id
        || !(Number(product.authorize_id) > 0) || row.authorize_id !== product.authorize_id
        || Number(existing.consign_id || 0) !== Number(payload.consign_id || 0)) throw new Error('商品、店铺或发货配置 ID 无法核对');
    if (Number(current.adjust_price?.status) === 1 || Number(existing.ex_url_status) === 1) throw new Error('已有自动调价或自助兑换设置，停止覆盖');
    if (Number(existing.status) === 1) {
      if (Number(existing.kind_way) === 4 && Number(existing.app_id) === payload.app_id && existing.goods_no === payload.goods_no) {
        return { dry_run: !apply, status: 'already-configured', after: current };
      }
      throw new Error('已有其他启用配置，保留原配置');
    }
    const list = (await this.source(payload.app_id, payload.goods_no))?.list;
    const matches = Array.isArray(list) ? list.filter(item => item.goods_no === payload.goods_no) : [];
    if (matches.length !== 1 || matches[0].title !== payload.goods_name
        || !Number.isFinite(Number(matches[0].purchase_price))
        || Math.round(Number(matches[0].purchase_price) * 100) !== payload.goods_price
        || Number(matches[0].stock) !== payload.goods_stock || !(payload.goods_stock > 0)) throw new Error('货源商品、价格或库存与预演不一致');
    if (!apply) return { dry_run: true, status: 'ready', before: current, payload };
    // No retries, including ambiguous write outcomes. Caller must query manually.
    await this.#request(SAVE_PATH, payload);
    const after = await this.info(id, payload.product_sku || 0);
    const c = after?.consign;
    if (Number(after?.product?.product_id) !== id || Number(c?.status) !== 1 || Number(c.kind_way) !== 4
        || Number(c.app_id) !== payload.app_id || c.goods_no !== payload.goods_no) throw new Error('保存后读回不一致，停止；不可盲目重试');
    return { dry_run: false, status: 'verified', after };
  }
  // No public arbitrary-path request or batch-save API.
}
