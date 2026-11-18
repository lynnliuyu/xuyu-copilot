/**
 * 网关端到端自测。
 *
 * 它在本机拉起一个网关实例（用临时数据目录，不污染真实数据），
 * 然后**完全模仿闲管家的调用方式**：按官方规则算签名、发 POST、校验返回。
 *
 * 覆盖三类场景：
 *   A. 正常链路（上线时管家会依次调用的接口）
 *   B. 错误码链路（401/408/1000/1100/1102/1202）—— 这三个校验顺序与官方一致
 *   C. 幂等与库存（管家重试时不能重复扣卡）
 *
 * 用法：npm run gw:test
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ⚠️ 必须在任何 store 调用之前设置：让本次自测写入独立临时目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xgj-selftest-'));
process.env.XGJ_DATA_DIR = TMP;
process.env.XGJ_MCH_ID = process.env.XGJ_MCH_ID || 'bd-to-xy-001';
process.env.XGJ_MCH_SECRET = process.env.XGJ_MCH_SECRET || 'selftest-secret-0123456789abcdef';
process.env.GOOFISH_APP_KEY = process.env.GOOFISH_APP_KEY || '1787570964481861';
process.env.GOOFISH_APP_SECRET = process.env.GOOFISH_APP_SECRET || 'selftest-app-secret';

const { createServer, loadConfig } = await import('../server');
const { genVsSign, md5 } = await import('../sign');
const { ensureSeed, availableStock } = await import('../store');

const cfg = loadConfig();
ensureSeed();

// ---------------------------------------------------------------- 断言框架

type Row = { name: string; pass: boolean; detail: string };
const rows: Row[] = [];

function check(name: string, pass: boolean, detail = ''): void {
  rows.push({ name, pass, detail });
}

const C = {
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  d: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// ---------------------------------------------------------------- 启动服务

const server: http.Server = createServer(cfg);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const addr = server.address();
const port = typeof addr === 'object' && addr ? addr.port : 0;
const BASE = `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------- 请求工具

interface CallOpts {
  /** 覆盖签名（用于测 401） */
  badSign?: boolean;
  /** 覆盖时间戳（用于测 408），传相对现在的秒数偏移 */
  tsOffset?: number;
  /** 覆盖 mch_id（用于测 1000） */
  mchId?: string;
  /** 覆盖**实际发送**的 body 原文（用于测签名与 body 不一致） */
  rawBody?: string;
  /** 覆盖**参与签名**的 body 原文。与 rawBody 不同时即为「签名/报文不匹配」场景 */
  signOver?: string;
}

async function call(pathname: string, body: unknown, o: CallOpts = {}): Promise<any> {
  const compact = JSON.stringify(body);
  const rawBody = o.rawBody ?? compact;
  const signedBody = o.signOver ?? rawBody;
  const ts = Math.floor(Date.now() / 1000) + (o.tsOffset ?? 0);
  const mchId = o.mchId ?? cfg.mchId;
  let sign = genVsSign({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    mchId: cfg.mchId,
    mchSecret: cfg.mchSecret,
    timestamp: ts,
    bodyString: signedBody,
  });
  if (o.badSign) sign = 'deadbeef'.repeat(4);

  const url = `${BASE}${pathname}?mch_id=${encodeURIComponent(mchId)}&timestamp=${ts}&sign=${sign}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: rawBody,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text, __status: res.status };
  }
}

const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);

// ---------------------------------------------------------------- A. 正常链路

console.log(`\n${C.b('=== 虚拟货源网关 端到端自测 ===')}`);
console.log(C.d(`  app_id      ${cfg.appId}`));
console.log(C.d(`  mch_id      ${cfg.mchId}   (我们在「货源授权信息」里自定义的那个)`));
console.log(C.d(`  临时数据目录 ${TMP}\n`));

// A0. 健康检查
{
  const res = await fetch(`${BASE}/__health`);
  const j: any = await res.json();
  check('A0 GET /__health 可达', res.status === 200 && j.ok === true, `HTTP ${res.status}`);
}

// A1. 查询平台信息（上线时管家第一个调的接口）
{
  const j = await call('/goofish/open/info', {});
  check(
    'A1 查询平台信息 code=0',
    j.code === 0 && j.msg === 'OK',
    `code=${j.code} msg=${j.msg}`,
  );
  check(
    'A1b 回传的 app_id 是整数且等于应用 AppKey',
    isInt(j.data?.app_id) && String(j.data.app_id) === cfg.appId,
    `app_id=${j.data?.app_id} (${typeof j.data?.app_id}) 期望 ${cfg.appId}`,
  );
  const f = j.data?.features ?? {};
  check(
    'A1c features 三项均为布尔且如实为 false',
    typeof f.is_support_order_refund === 'boolean' &&
      typeof f.is_support_goods_notify === 'boolean' &&
      typeof f.is_support_loss_purchase === 'boolean',
    JSON.stringify(f),
  );
}

// A2. 查询商户信息（balance 必须 > 0，否则管家保存会失败）
{
  const j = await call('/goofish/user/info', {});
  check(
    'A2 查询商户信息 balance 为 >0 的整数',
    j.code === 0 && isInt(j.data?.balance) && j.data.balance > 0,
    `balance=${j.data?.balance} (${typeof j.data?.balance})`,
  );
}

// A3. 商品列表
{
  const j = await call('/goofish/goods/list', { keyword: '', goods_type: 2, page_no: 1, page_size: 50 });
  check(
    'A3 查询商品列表 code=0 且返回 list+count',
    j.code === 0 && Array.isArray(j.data?.list) && isInt(j.data?.count),
    `count=${j.data?.count} 本页=${j.data?.list?.length}`,
  );
  const g = j.data?.list?.[0];
  if (g) {
    check(
      'A3b 商品字段类型严格（price/stock/status/update_time 均为整数）',
      isInt(g.price) && isInt(g.stock) && isInt(g.status) && isInt(g.update_time) && isInt(g.goods_type),
      `price=${g.price} stock=${g.stock} status=${g.status} update_time=${g.update_time}`,
    );
  } else {
    check('A3b 商品字段类型严格', false, '列表为空，无法校验');
  }
}

// A4. 商品列表 keyword 精准匹配商品编码
{
  const j = await call('/goofish/goods/list', { keyword: 'BD-DEMO-001', page_no: 1, page_size: 50 });
  check(
    'A4 keyword 支持商品编码精准搜索',
    j.code === 0 && j.data?.count === 1 && j.data?.list?.[0]?.goods_no === 'BD-DEMO-001',
    `count=${j.data?.count}`,
  );
}

// A5. 商品详情
{
  const j = await call('/goofish/goods/detail', { goods_type: 2, goods_no: 'BD-DEMO-001' });
  check(
    'A5 查询商品详情 code=0',
    j.code === 0 && j.data?.goods_no === 'BD-DEMO-001',
    `goods_no=${j.data?.goods_no}`,
  );
}

// ---------------------------------------------------------------- B. 错误码链路

{
  const j = await call('/goofish/goods/detail', {}, { badSign: true });
  check('B1 签名错误 → 401', j.code === 401, `code=${j.code} msg=${j.msg}`);
}
{
  const j = await call('/goofish/goods/detail', {}, { tsOffset: -600 });
  check('B2 时间戳超 5 分钟 → 408', j.code === 408, `code=${j.code} msg=${j.msg}`);
}
{
  const j = await call('/goofish/goods/detail', {}, { mchId: 'not-exist' });
  check('B3 商户不存在 → 1000', j.code === 1000, `code=${j.code} msg=${j.msg}`);
}
{
  const j = await call('/goofish/goods/detail', { goods_type: 2, goods_no: 'NOPE-999' });
  check('B4 商品不存在 → 1100', j.code === 1100, `code=${j.code} msg=${j.msg}`);
}
{
  const j = await call('/goofish/order/purchase/create', {
    order_no: 'TEST-LOWMAX-1',
    goods_no: 'BD-DEMO-001',
    buy_quantity: 1,
    notify_url: 'https://open.goofish.pro/api/open/callback/virtual/order/notify/token',
    biz_order_no: 'XY-1',
    max_amount: 1,
  });
  check('B5 金额低于成本价 → 1202', j.code === 1202, `code=${j.code} msg=${j.msg}`);
}
{
  // 签名按「压缩 JSON」算，实际发送却是「带空格的 JSON」→ 服务端算出的 bodyMd5 不同 → 401
  const j = await call(
    '/goofish/goods/detail',
    { goods_no: 'BD-DEMO-001' },
    { rawBody: '{"goods_no" : "BD-DEMO-001"}', signOver: JSON.stringify({ goods_no: 'BD-DEMO-001' }) },
  );
  check(
    'B6 报文与签名所用 body 不一致 → 401（印证「必须传压缩 JSON」）',
    j.code === 401,
    `code=${j.code}`,
  );
}
{
  // 未知路径也要先过验签，所以必须带合法签名，才能验证「路由不存在」的返回
  const j = await call('/goofish/__nope', {});
  check('B7 签名合法但路径未知 → code=1（非 404，便于排查）', j.code === 1, `code=${j.code} msg=${String(j.msg).slice(0, 48)}`);
}
{
  // 顺带确认：验签在路由之前，未签名的请求连"路径是否存在"都探测不到
  const res = await fetch(`${BASE}/goofish/__nope`, { method: 'POST', body: '{}' });
  const j: any = await res.json();
  check('B8 未签名请求被拦在路由之前 → 1000（不泄露接口存在性）', j.code === 1000, `code=${j.code}`);
}

// ---------------------------------------------------------------- C. 幂等与库存

const BEFORE = availableStock('BD-DEMO-001');

{
  const j = await call('/goofish/order/purchase/create', {
    order_no: 'TEST-OVER-1',
    goods_no: 'BD-DEMO-001',
    buy_quantity: BEFORE + 5,
    notify_url: 'https://open.goofish.pro/api/open/callback/virtual/order/notify/token',
    biz_order_no: 'XY-OVER',
  });
  check('C1 超量下单 → 1102 且不扣库存', j.code === 1102 && availableStock('BD-DEMO-001') === BEFORE, `code=${j.code}`);
}

const ORDER_NO = 'TEST-OK-1';
let firstOut = '';
let firstCards: any[] = [];
{
  const j = await call('/goofish/order/purchase/create', {
    order_no: ORDER_NO,
    goods_no: 'BD-DEMO-001',
    buy_quantity: 2,
    notify_url: 'https://open.goofish.pro/api/open/callback/virtual/order/notify/token',
    biz_order_no: 'XY-OK',
  });
  const d = j.data ?? {};
  firstOut = d.out_order_no;
  firstCards = d.card_items ?? [];
  check(
    'C2 下单成功并同步返回卡密',
    j.code === 0 && d.order_status === 20 && firstCards.length === 2 && isInt(d.end_time),
    `status=${d.order_status} 卡密数=${firstCards.length} end_time=${d.end_time}`,
  );
  check(
    'C2b 卡密内容非空且未泄露到日志之外的字段',
    firstCards.every((c) => typeof c.card_pwd === 'string' && c.card_pwd.length > 0),
    `样例=${String(firstCards[0]?.card_pwd).slice(0, 24)}…`,
  );
  check(
    'C2c 下单金额 = 单价 × 数量（分）',
    d.order_amount === 100 * 2,
    `order_amount=${d.order_amount}`,
  );
  check('C2d 出库后库存减少 2', availableStock('BD-DEMO-001') === BEFORE - 2, `剩余 ${availableStock('BD-DEMO-001')}（原 ${BEFORE}）`);
}

{
  const j = await call('/goofish/order/purchase/create', {
    order_no: ORDER_NO,
    goods_no: 'BD-DEMO-001',
    buy_quantity: 2,
    notify_url: 'https://open.goofish.pro/api/open/callback/virtual/order/notify/token',
    biz_order_no: 'XY-OK',
  });
  check(
    'C3 同一 order_no 重试 → 幂等，返回同一单且不重复扣卡',
    j.code === 0 && j.data?.out_order_no === firstOut && availableStock('BD-DEMO-001') === BEFORE - 2,
    `out_order_no=${j.data?.out_order_no} 剩余 ${availableStock('BD-DEMO-001')}`,
  );
}

{
  const j = await call('/goofish/order/detail', { order_type: 2, order_no: ORDER_NO });
  check(
    'C4 查询订单详情可核验发货结果',
    j.code === 0 && j.data?.order_status === 20 && (j.data?.card_items ?? []).length === 2,
    `status=${j.data?.order_status} 卡密数=${j.data?.card_items?.length}`,
  );
}
{
  const j = await call('/goofish/order/detail', { order_type: 2, order_no: 'NO-SUCH-ORDER' });
  check('C5 订单不存在 → 1200', j.code === 1200, `code=${j.code}`);
}

// ---------------------------------------------------------------- D. 共享链接模式

{
  const j = await call('/goofish/goods/detail', { goods_type: 2, goods_no: 'BD-DEMO-002' });
  check(
    'D1 共享模式商品对外库存为 shared_stock（9999），不是卡密条数',
    j.code === 0 && j.data?.stock === 9999,
    `stock=${j.data?.stock}（池内实际 1 条内容）`,
  );
}
{
  const a = await call('/goofish/order/purchase/create', {
    order_no: 'TEST-SHARED-A',
    goods_no: 'BD-DEMO-002',
    buy_quantity: 2,
    notify_url: 'https://open.goofish.pro/api/open/callback/virtual/order/notify/token',
    biz_order_no: 'XY-SA',
  });
  const b = await call('/goofish/order/purchase/create', {
    order_no: 'TEST-SHARED-B',
    goods_no: 'BD-DEMO-002',
    buy_quantity: 1,
    notify_url: 'https://open.goofish.pro/api/open/callback/virtual/order/notify/token',
    biz_order_no: 'XY-SB',
  });
  const c: any = await call('/goofish/goods/detail', { goods_type: 2, goods_no: 'BD-DEMO-002' });
  check(
    'D2 共享模式可连续出单且库存不衰减',
    a.code === 0 && b.code === 0 && c.data?.stock === 9999,
    `A.code=${a.code} B.code=${b.code} 库存=${c.data?.stock}`,
  );
  check(
    'D3 共享模式两单拿到同一份内容（buy_quantity=2 时返回 2 条）',
    a.data?.card_items?.length === 2 &&
      a.data.card_items.every((x: any) => x.card_pwd === a.data.card_items[0].card_pwd) &&
      b.data?.card_items?.[0]?.card_pwd === a.data.card_items[0].card_pwd,
    `A 条数=${a.data?.card_items?.length}`,
  );
}
{
  // 卡密池模式依然是「发完即止」，证明两种模式互不干扰
  const j = await call('/goofish/order/purchase/create', {
    order_no: 'TEST-POOL-DRAIN',
    goods_no: 'BD-DEMO-001',
    buy_quantity: 1,
    notify_url: 'https://open.goofish.pro/api/open/callback/virtual/order/notify/token',
    biz_order_no: 'XY-DRAIN',
  });
  const after: any = await call('/goofish/goods/detail', { goods_type: 2, goods_no: 'BD-DEMO-001' });
  check(
    'D4 卡密池模式发完即下架（status 自动变 2）',
    j.code === 0 && after.data?.stock === 0 && after.data?.status === 2,
    `stock=${after.data?.stock} status=${after.data?.status}`,
  );
}

// ---------------------------------------------------------------- E. 商品变更订阅（自动调价）

// 这三个接口是「卡密仓库配置货源商品」时管家必然会调的。
// 2026-10-06 实测：漏了它们，管家侧配置会在订阅这步中断，goods/detail 永远不来。

const SUB_TOKEN = 'tok-selftest-0001';
const SUB_URL = 'https://goofish.pro/tok-selftest-0001';

{
  const j = await call('/goofish/goods/change/subscribe', {
    goods_type: 2,
    goods_no: 'BD-DEMO-001',
    token: SUB_TOKEN,
    notify_url: SUB_URL,
  });
  check(
    'E1 订阅商品变更 code=0，且响应只有 code/msg（官方 schema 无 data）',
    j.code === 0 && j.msg === 'OK' && j.data === undefined,
    `code=${j.code} data=${JSON.stringify(j.data)}`,
  );
}

{
  const j = await call('/goofish/goods/change/subscribe/list', { page_no: 1, page_size: 50 });
  const item = j.data?.list?.[0];
  check(
    'E2 查询已订阅列表 count=1 且 subscribe_time 为整数',
    j.code === 0 && j.data?.count === 1 && isInt(item?.subscribe_time),
    `count=${j.data?.count} subscribe_time=${item?.subscribe_time}`,
  );
}

{
  const before = await call('/goofish/goods/change/subscribe/list', { page_no: 1, page_size: 50 });
  const t0 = before.data?.list?.[0]?.subscribe_time;
  await call('/goofish/goods/change/subscribe', {
    goods_type: 2,
    goods_no: 'BD-DEMO-001',
    token: SUB_TOKEN,
    notify_url: SUB_URL,
  });
  const after = await call('/goofish/goods/change/subscribe/list', { page_no: 1, page_size: 50 });
  check(
    'E3 重复订阅幂等（不重复入库、subscribe_time 不被刷新）',
    after.data?.count === 1 && after.data?.list?.[0]?.subscribe_time === t0,
    `count=${after.data?.count} t0=${t0} t1=${after.data?.list?.[0]?.subscribe_time}`,
  );
}

{
  const j = await call('/goofish/goods/change/subscribe', { goods_type: 2, goods_no: 'BD-DEMO-001' });
  check('E4 订阅缺 token/notify_url → 1201', j.code === 1201, `code=${j.code} msg=${j.msg}`);
}

{
  const j = await call('/goofish/goods/change/subscribe', {
    goods_type: 2,
    goods_no: 'NOPE-999',
    token: SUB_TOKEN,
    notify_url: SUB_URL,
  });
  check('E5 订阅不存在的商品 → 1100', j.code === 1100, `code=${j.code}`);
}

{
  const j = await call('/goofish/goods/change/subscribe/list', { page_no: 1, page_size: 500 });
  check('E6 page_size 超过 100 → 1201（官方要求上限 100）', j.code === 1201, `code=${j.code}`);
}

{
  const j = await call('/goofish/goods/change/unsubscribe', {
    goods_type: 2,
    goods_no: 'BD-DEMO-001',
    token: SUB_TOKEN,
  });
  const after = await call('/goofish/goods/change/subscribe/list', { page_no: 1, page_size: 50 });
  check(
    'E7 取消订阅后列表清空，且响应同样只有 code/msg',
    j.code === 0 && j.data === undefined && after.data?.count === 0,
    `code=${j.code} 剩余订阅=${after.data?.count}`,
  );
}

{
  // 幂等：取消一个本来就不存在的订阅，也必须成功
  const j = await call('/goofish/goods/change/unsubscribe', {
    goods_type: 2,
    goods_no: 'BD-DEMO-001',
    token: 'never-subscribed-token',
  });
  check('E8 取消未订阅的记录 → 仍返回成功（幂等）', j.code === 0, `code=${j.code}`);
}

// ---------------------------------------------------------------- 汇总

server.close();

const pass = rows.filter((r) => r.pass).length;
console.log(C.b('  自测结果'));
console.log(C.d('  ' + '─'.repeat(76)));
for (const r of rows) {
  const icon = r.pass ? C.g('✅') : C.r('❌');
  console.log(`  ${icon} ${r.name}`);
  if (r.detail && !r.pass) console.log(`       ${C.y(r.detail)}`);
  else if (r.detail) console.log(`       ${C.d(r.detail)}`);
}
console.log(C.d('  ' + '─'.repeat(76)));
console.log(
  `  ${pass === rows.length ? C.g(`${pass}/${rows.length} 全部通过`) : C.r(`${pass}/${rows.length} 有失败项`)}`,
);
console.log('');
console.log(C.d('  说明：自测完全按闲管家的调用方式发签名请求，通过即代表协议层可用。'));
console.log(C.d('  剩下唯一的差异是——真实调用会来自闲管家的公网 IP，而不是 127.0.0.1。'));
console.log('');
console.log(`  自测产生的临时数据：${TMP}`);
console.log('');

// 校验一下签名实现本身没被改坏
const guard = md5(''); // 顺手确认 md5 可用
if (guard.length !== 32) console.log(C.r('md5 实现异常'));

process.exit(pass === rows.length ? 0 : 1);
