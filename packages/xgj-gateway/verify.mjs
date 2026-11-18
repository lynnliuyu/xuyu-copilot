#!/usr/bin/env node
/**
 * 对**已部署的网关**做端到端验收（纯 Node，零依赖）。
 *
 * 它完全模仿闲管家的调用方式：按官方规则算签名、发 POST、核对返回。
 * 可以直接打本机容器、打远程服务器、打已上线到闲管家的地址。
 *
 * 用法：
 *   node verify.mjs                                     # 默认 http://127.0.0.1:8787
 *   node verify.mjs https://your-gateway.example.com
 *   XGJ_MCH_ID=... XGJ_MCH_SECRET=... GOOFISH_APP_KEY=... GOOFISH_APP_SECRET=... node verify.mjs <url>
 *
 * 退出码：0 全部通过；1 有失败项。
 *
 * ⚠️ 本脚本只读 + 下单演练。它会**真的调用 purchase/create**（在货源的样例商品上），
 *    因此会消耗一条样例卡密、并写一条订单台账。不碰真实商品。
 */
import { createHash } from 'node:crypto';

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const CFG = {
  mchId: process.env.XGJ_MCH_ID ?? 'test-mch',
  mchSecret: process.env.XGJ_MCH_SECRET ?? 'secret-0123456789abcdef',
  appId: process.env.GOOFISH_APP_KEY ?? '1787570964481861',
  appSecret: process.env.GOOFISH_APP_SECRET ?? 'app-secret-test',
};

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const sign = (bodyString, ts, mchId) =>
  md5([CFG.appId, CFG.appSecret, md5(bodyString), ts, mchId ?? CFG.mchId, CFG.mchSecret].join(','));

async function call(path, body = {}, over = {}) {
  const raw = JSON.stringify(body);
  const ts = over.ts ?? Math.floor(Date.now() / 1000);
  const mchId = over.mchId ?? CFG.mchId;
  const query = new URLSearchParams({
    mch_id: mchId,
    timestamp: String(ts),
    sign: over.sign ?? sign(over.signOver ?? raw, ts, mchId),
  });
  const res = await fetch(`${BASE}${path}?${query}`, {
    method: over.method ?? 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    ...(over.method === 'GET' ? {} : { body: raw }),
  });
  return { status: res.status, json: await res.json() };
}

const PROBE_GOODS = process.env.XGJ_PROBE_GOODS ?? 'BD-DEMO-001';

console.log(`\n验收目标：${BASE}\n`);

/* ── A. 应用上线时会调的两个基础接口 ─────────────────────────── */
const open = await call('/goofish/open/info');
check('A1 查询平台信息 code=0', open.json.code === 0, `code=${open.json.code}`);
check('A2 app_id 为整数且原样回传', open.json.data?.app_id === Number(CFG.appId), `app_id=${open.json.data?.app_id}`);
check(
  'A3 features 三个布尔字段齐全',
  ['is_support_order_refund', 'is_support_goods_notify', 'is_support_loss_purchase'].every(
    (k) => typeof open.json.data?.features?.[k] === 'boolean',
  ),
);
const user = await call('/goofish/user/info');
check('A4 商户信息 balance > 0', user.json.code === 0 && Number(user.json.data?.balance) > 0, `balance=${user.json.data?.balance}`);

/* ── B. 商品接口 ──────────────────────────────────────────── */
const list = await call('/goofish/goods/list', { goods_type: 2, keyword: '', page_no: 1, page_size: 50 });
check('B1 商品列表有数据', list.json.code === 0 && list.json.data?.count > 0, `count=${list.json.data?.count}`);
check('B2 goods_type=1 也放行（枚举兼容）', (await call('/goofish/goods/list', { goods_type: 1, page_no: 1, page_size: 50 })).json.data?.count === list.json.data?.count);

const detail = await call('/goofish/goods/detail', { goods_type: 2, goods_no: PROBE_GOODS });
check(
  `B3 商品详情字段齐全（${PROBE_GOODS}）`,
  detail.json.code === 0 &&
    ['goods_no', 'goods_type', 'goods_name', 'price', 'stock', 'status', 'update_time'].every(
      (k) => detail.json.data?.[k] !== undefined,
    ),
  `stock=${detail.json.data?.stock}`,
);

if (detail.json.code === 0) {
  /* ── C. 下单（同步发卡） ─────────────────────────────────── */
  const orderNo = `VERIFY-${Date.now()}`;
  const before = detail.json.data.stock;
  const buy = await call('/goofish/order/purchase/create', {
    order_no: orderNo, goods_no: PROBE_GOODS, buy_quantity: 1, max_amount: 1000000,
  });
  check('C1 创建卡密订单 code=0', buy.json.code === 0, `code=${buy.json.code}`);
  check('C2 同步返回 card_items', Array.isArray(buy.json.data?.card_items) && buy.json.data.card_items.length === 1);
  check('C3 order_status=20', buy.json.data?.order_status === 20, `status=${buy.json.data?.order_status}`);

  const after = (await call('/goofish/goods/detail', { goods_type: 2, goods_no: PROBE_GOODS })).json.data?.stock;
  // 共享模式不消耗卡密，所以只对「库存减少」或「本来就是共享商品」两种情况放行
  check('C4 出卡后库存不增（池模式应 -1）', typeof after === 'number' && after <= before, `${before} → ${after}`);

  const retry = await call('/goofish/order/purchase/create', {
    order_no: orderNo, goods_no: PROBE_GOODS, buy_quantity: 1, max_amount: 1000000,
  });
  const afterRetry = (await call('/goofish/goods/detail', { goods_type: 2, goods_no: PROBE_GOODS })).json.data?.stock;
  check('C5 同 order_no 重试返回同一结果', retry.json.data?.out_order_no === buy.json.data?.out_order_no);
  check('C6 重试不再扣库存', afterRetry === after, `${after} → ${afterRetry}`);
  check('C7 查询订单详情能核验到', (await call('/goofish/order/detail', { order_no: orderNo })).json.code === 0);
}

/* ── D. 错误码 ────────────────────────────────────────────── */
check('D1 商品不存在 → 1100', (await call('/goofish/goods/detail', { goods_type: 2, goods_no: 'NO-SUCH' })).json.code === 1100);
check('D2 缺参数 → 1201', (await call('/goofish/order/purchase/create', { order_no: '' })).json.code === 1201);
check('D3 订单不存在 → 1200', (await call('/goofish/order/detail', { order_no: 'NOPE' })).json.code === 1200);
check('D4 未知路径 → code=1（非 404）', (await call('/goofish/nope', {})).json.code === 1);

/* ── E. 鉴权 ──────────────────────────────────────────────── */
check('E1 商户号不匹配 → 1000', (await call('/goofish/open/info', {}, { mchId: 'someone-else', sign: 'x' })).json.code === 1000);
check('E2 时间戳过期 → 408', (await call('/goofish/open/info', {}, { ts: Math.floor(Date.now() / 1000) - 9999 })).json.code === 408);
check('E3 签名错误 → 401', (await call('/goofish/open/info', {}, { sign: 'a'.repeat(32) })).json.code === 401);
check(
  'E4 签名覆盖实际发送的字节（改 body 即 401）',
  (await call('/goofish/goods/detail', { goods_no: PROBE_GOODS }, { signOver: JSON.stringify({ goods_no: 'OTHER' }) })).json.code === 401,
);

/* ── F. 探测与健康检查 ────────────────────────────────────── */
const probe = await call('/goofish/goods/list', {}, { method: 'GET' });
check('F1 GET 探测回 200（否则闲管家判定接口不可用）', probe.status === 200 && probe.json.code === 0);
const health = await fetch(`${BASE}/__health`);
check('F2 /__health 可用（无需签名）', health.status === 200 && (await health.json()).ok === true);

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${pass}/${pass + fail}\n`);
process.exitCode = fail === 0 ? 0 : 1;
