/**
 * 网关公网链路验收。
 *
 * 与 gw:test（自测）的区别：
 *   · selftest 在自己进程内起一个服务，验证的是「实现是否符合官方协议」；
 *   · 本脚本对着**已经跑起来的地址**发请求，验证的是「这条链路真的通」
 *     —— 包括 Docker 容器、端口映射、Cloudflare 隧道、以及闲管家将要走的同一条路。
 *
 * 用法：
 *   npx tsx scripts/live-check.ts                                # 默认打 http://127.0.0.1:8787
 *   npx tsx scripts/live-check.ts https://xxx.trycloudflare.com
 *   npx tsx scripts/live-check.ts <url> --no-order               # 跳过真实下单（不动卡密池）
 */
import { opt } from '../packages/bdpan-core/src/env';
import { genVsSign } from '../packages/xgj-gateway/src/sign';

const argv = process.argv.slice(2);
const skipOrder = argv.includes('--no-order');
const BASE = (argv.find((a) => !a.startsWith('--')) ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');

const APP_ID = opt('GOOFISH_APP_KEY');
const APP_SECRET = opt('GOOFISH_APP_SECRET');
const MCH_ID = opt('XGJ_MCH_ID');
const MCH_SECRET = opt('XGJ_MCH_SECRET');

const C = {
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  d: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

let pass = 0;
let fail = 0;

function report(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++;
  else fail++;
  console.log('  ' + (ok ? C.g('✅') : C.r('❌')) + ' ' + name);
  if (detail) console.log('       ' + (ok ? C.d(detail) : C.y(detail)));
}

interface CallOpts {
  badSign?: boolean;
  mchId?: string;
  tsOffset?: number;
}

/** 完全按闲管家的方式发一个签名请求 */
async function call(
  pathname: string,
  body: unknown,
  o: CallOpts = {},
): Promise<{ http: number; json: any; ms: number }> {
  const raw = JSON.stringify(body ?? {});
  const ts = Math.floor(Date.now() / 1000) + (o.tsOffset ?? 0);
  const mchId = o.mchId ?? MCH_ID;
  let sign = genVsSign({
    appId: APP_ID,
    appSecret: APP_SECRET,
    mchId: MCH_ID,
    mchSecret: MCH_SECRET,
    timestamp: ts,
    bodyString: raw,
  });
  if (o.badSign) sign = 'deadbeef'.repeat(4);

  const url = BASE + pathname + '?mch_id=' + encodeURIComponent(mchId) + '&timestamp=' + ts + '&sign=' + sign;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: raw,
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { __raw: text.slice(0, 200) };
  }
  return { http: res.status, json, ms: Date.now() - t0 };
}

// ------------------------------------------------------------------ 开始

console.log('');
console.log(C.b('=== 公网链路验收 ==='));
console.log(C.d('  目标地址  ' + BASE));
console.log(C.d('  mch_id    ' + MCH_ID));
console.log(C.d('  app_id    ' + APP_ID));
console.log('');

if (!APP_ID || !APP_SECRET || !MCH_ID || !MCH_SECRET) {
  console.error(C.r('❌ .env 缺少 GOOFISH_APP_KEY / GOOFISH_APP_SECRET / XGJ_MCH_ID / XGJ_MCH_SECRET'));
  process.exit(2);
}

// 1. 健康检查（无需签名，用来判断隧道是否打到了网关）
try {
  const t0 = Date.now();
  const res = await fetch(BASE + '/__health', { signal: AbortSignal.timeout(15000) });
  const j: any = await res.json();
  report('1  健康检查可达', res.status === 200 && j.ok === true, res.status + ' ' + j.service + ' ' + (Date.now() - t0) + 'ms');
} catch (e: any) {
  report('1  健康检查可达', false, '连不上：' + e.message);
  console.log('');
  console.log(C.r('  隧道还没通，后面的接口测试先跳过。'));
  console.log(C.d('  排查： docker compose logs --tail=50 cloudflared'));
  process.exit(1);
}

// 2. 上线时闲管家第一个调的接口
{
  const r = await call('/goofish/open/info', {});
  report(
    '2  查询平台信息（闲管家点「上线」时会调）',
    r.json.code === 0 && Number.isInteger(r.json.data?.app_id) && String(r.json.data.app_id) === APP_ID,
    'code=' + r.json.code + ' app_id=' + r.json.data?.app_id + ' (' + typeof r.json.data?.app_id + ') ' + r.ms + 'ms',
  );
  report(
    '2b features 三项均为布尔',
    typeof r.json.data?.features?.is_support_order_refund === 'boolean',
    JSON.stringify(r.json.data?.features),
  );
}

// 3. 商户信息（balance 必须 > 0，否则管家侧保存失败）
{
  const r = await call('/goofish/user/info', {});
  report(
    '3  查询商户信息 balance > 0',
    r.json.code === 0 && Number.isInteger(r.json.data?.balance) && r.json.data.balance > 0,
    'code=' + r.json.code + ' balance=' + r.json.data?.balance + ' ' + r.ms + 'ms',
  );
}

// 4. 商品列表
let firstGoods = '';
{
  const r = await call('/goofish/goods/list', { keyword: '', goods_type: 2, page_no: 1, page_size: 50 });
  const list = r.json.data?.list ?? [];
  firstGoods = list[0]?.goods_no ?? '';
  report(
    '4  查询商品列表',
    r.json.code === 0 && Array.isArray(list) && Number.isInteger(r.json.data?.count),
    'count=' + r.json.data?.count + ' 本页=' + list.length + ' ' + r.ms + 'ms',
  );
  if (list[0]) {
    const g = list[0];
    const line = '       · ' + g.goods_no + '  ' + g.goods_name + '  价 ' + (g.price / 100).toFixed(2) + ' 元  库存 ' + g.stock + '  状态 ' + g.status;
    console.log(C.d(line));
  }
}

// 5. 商品详情
if (firstGoods) {
  const r = await call('/goofish/goods/detail', { goods_type: 2, goods_no: firstGoods });
  report('5  查询商品详情', r.json.code === 0 && r.json.data?.goods_no === firstGoods, 'code=' + r.json.code + ' ' + r.ms + 'ms');
}

// 5b. 商品变更订阅 —— 2026-10-06 实测补上：
// 管家在「卡密仓库配置货源商品」时，顺序是 goods/list → 订阅 → goods/detail。
// 订阅这步返回失败，管家侧配置会直接中断，goods/detail 永远不来。
if (firstGoods) {
  const token = 'live-check-' + Date.now();
  const notifyUrl = 'https://goofish.pro/' + token;

  const sub = await call('/goofish/goods/change/subscribe', {
    goods_type: 2,
    goods_no: firstGoods,
    token,
    notify_url: notifyUrl,
  });
  report(
    '5b 订阅商品变更（管家配货源必调，漏了会中断配置）',
    sub.json.code === 0 && sub.json.data === undefined,
    'code=' + sub.json.code + ' data=' + JSON.stringify(sub.json.data) + ' ' + sub.ms + 'ms',
  );

  const lst = await call('/goofish/goods/change/subscribe/list', { page_no: 1, page_size: 100 });
  const found = (lst.json.data?.list ?? []).some((x: any) => x.goods_no === firstGoods && x.token === token);
  report(
    '5c 查询已订阅列表能找到刚才那条',
    lst.json.code === 0 && found,
    'count=' + lst.json.data?.count + ' 命中=' + found,
  );

  // 自清理：验收不留垃圾数据，不然会污染后续对账
  const un = await call('/goofish/goods/change/unsubscribe', {
    goods_type: 2,
    goods_no: firstGoods,
    token,
  });
  const lst2 = await call('/goofish/goods/change/subscribe/list', { page_no: 1, page_size: 100 });
  const still = (lst2.json.data?.list ?? []).some((x: any) => x.token === token);
  report(
    '5d 取消订阅后不再出现（顺带自清理）',
    un.json.code === 0 && !still,
    'code=' + un.json.code + ' 仍然存在=' + still,
  );
}

// 6. 真实下单（链路的关键一环：闲管家出单 → 我们发卡）
if (!skipOrder && firstGoods) {
  const orderNo = 'LIVE-CHECK-' + new Date().toISOString().slice(0, 10);
  const createBody = {
    order_no: orderNo,
    goods_no: firstGoods,
    buy_quantity: 1,
    biz_order_no: 'XY-LIVE-CHECK',
    notify_url: 'https://open.goofish.pro/api/open/callback/virtual/order/notify/token',
  };
  const r = await call('/goofish/order/purchase/create', createBody);
  const cards = r.json.data?.card_items ?? [];
  report(
    '6  创建订单并同步返回卡密',
    r.json.code === 0 && r.json.data?.order_status === 20 && cards.length === 1,
    'code=' + r.json.code + ' order_no=' + orderNo + ' 状态=' + r.json.data?.order_status + ' 卡密=' + cards.length + ' 条 ' + r.ms + 'ms',
  );
  if (cards[0]) {
    const v = String(cards[0].card_pwd);
    console.log(C.d('       卡密内容：' + (v.length > 60 ? v.slice(0, 60) + '…' : v)));
  }
  const created = r.json.data?.out_order_no;

  // 6b. 幂等：同一单重试不能重复发卡
  const again = await call('/goofish/order/purchase/create', createBody);
  report(
    '6b 同一 order_no 重试 → 幂等（闲管家会重试，不能重复扣卡）',
    again.json.code === 0 && again.json.data?.out_order_no === created,
    'out_order_no 一致=' + (again.json.data?.out_order_no === created),
  );

  // 6c. 订单详情（管家用它核验发货）
  const detail = await call('/goofish/order/detail', { order_type: 2, order_no: orderNo });
  report(
    '6c 查询订单详情可核验',
    detail.json.code === 0 && detail.json.data?.order_status === 20,
    'code=' + detail.json.code + ' 状态=' + detail.json.data?.order_status,
  );
}

// 7. 错误码链路（证明验签真的在生效，而不是「谁都能调」）
{
  const r1 = await call('/goofish/goods/detail', {}, { badSign: true });
  report('7  签名错误 → 401', r1.json.code === 401, 'code=' + r1.json.code + ' msg=' + r1.json.msg);
}
{
  const r2 = await call('/goofish/goods/detail', {}, { mchId: 'not-exist' });
  report('7b 商户不存在 → 1000', r2.json.code === 1000, 'code=' + r2.json.code + ' msg=' + r2.json.msg);
}
{
  const r3 = await call('/goofish/goods/detail', {}, { tsOffset: -600 });
  report('7c 时间戳超 5 分钟 → 408', r3.json.code === 408, 'code=' + r3.json.code + ' msg=' + r3.json.msg);
}

// ------------------------------------------------------------------ 汇总

console.log('');
console.log(C.d('  ' + '─'.repeat(72)));
const total = pass + fail;
console.log(fail === 0 ? '  ' + C.g(total + '/' + total + ' 全部通过') : '  ' + C.r(total + '/' + total + '，失败 ' + fail + ' 项'));
console.log('');
if (fail === 0) {
  console.log(C.d('  这条链路已经是闲管家将要走的那条路：'));
  console.log(C.d('  闲管家出单 → 公网隧道 → 网关验签 → 出卡 → 返回卡密。'));
  console.log(C.d('  下一步：把上面的地址填进'));
  console.log(C.d('  闲管家 → 我的应用 → 货源授权信息 → 接口网关，然后点上线。'));
  console.log('');
}
process.exit(fail === 0 ? 0 : 1);
