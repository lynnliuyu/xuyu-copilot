import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
// @ts-expect-error 本地 mjs/ts 模块
import { genVsSign, md5, safeEqual } from '../packages/xgj-gateway/src/sign';
// @ts-expect-error
import { createServer, normalizePath, inGoofishRange } from '../packages/xgj-gateway/src/server';
// @ts-expect-error
import { createHandlers } from '../packages/xgj-gateway/src/handlers';
// @ts-expect-error
import { createMemoryStore } from '../packages/xgj-gateway/src/store';

const CFG = {
  port: 0,
  mchId: 'test-mch',
  mchSecret: 'mch-secret-0123456789abcdef',
  appId: '1787570964481861',
  appSecret: 'app-secret-0123456789abcdef',
  ipWhitelist: false,
  timestampTolerance: 300,
  logBody: false,
};

const GOODS = [
  { goods_no: 'T-POOL', goods_type: 2, goods_name: '池模式商品', price: 288, stock: 9, status: 1, update_time: 1 },
  { goods_no: 'T-SHARED', goods_type: 2, goods_name: '共享模式商品', price: 188, stock: 9, status: 1, update_time: 1, stock_mode: 'shared', shared_stock: 9999 },
];

function memoryStore(cards?: any) {
  return createMemoryStore({
    merchant: { mch_id: CFG.mchId, balance: 999999 },
    goods: GOODS as any,
    cards:
      cards ??
      ({
        'T-POOL': [
          { card_no: 'K1', card_pwd: '卡一', used: false },
          { card_no: 'K2', card_pwd: '卡二', used: false },
        ],
        'T-SHARED': [{ card_pwd: '共享内容', used: false }],
      } as any),
  });
}

/* ---------------- 签名 ---------------- */

test('VS signature matches the official test vector', () => {
  const body = '{"goods_type":1,"goods_no":"12344532"}';
  assert.equal(md5(body), '9b8030f5097d5ed123405b003dd247c5');
  assert.equal(
    genVsSign({
      appId: '677859093659717',
      appSecret: 'wK63PxlOBaY9NoqMksLeZySzGIW25ifA',
      mchId: '100',
      mchSecret: 'o9wl81dncmvby3ijpq7eur456zhgtaxs',
      timestamp: 1724414553,
      bodyString: body,
    }),
    'f8677927fd8421a75718e8cfaaf92221',
  );
});

test('signature is byte-sensitive and constant-time comparand rejects junk', () => {
  const base = { appId: 'a', appSecret: 'b', mchId: 'c', mchSecret: 'd', timestamp: 1 };
  assert.notEqual(genVsSign({ ...base, bodyString: '{}' }), genVsSign({ ...base, bodyString: '{ }' }));
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});

/* ---------------- 路径与 IP ---------------- */

test('path normalization tolerates sub-path gateways; IP range only trusts real sockets', () => {
  assert.equal(normalizePath('/xgj/open/goofish/goods/list'), '/goofish/goods/list');
  assert.equal(normalizePath('/goofish/goods/list'), '/goofish/goods/list');
  assert.equal(normalizePath('/nope'), '/nope');
  assert.equal(inGoofishRange('47.106.99.78'), true);
  assert.equal(inGoofishRange('::ffff:120.78.1.1'), true);
  assert.equal(inGoofishRange('8.8.8.8'), false);
  assert.equal(inGoofishRange('not-an-ip'), false);
});

/* ---------------- 处理器：直接用注入的 store ---------------- */

test('handlers run against an injected store with no filesystem at all', () => {
  const store = memoryStore();
  const h = createHandlers(store, { appId: CFG.appId });

  assert.equal(h.handlePlatformInfo().data.app_id, Number(CFG.appId));
  assert.equal(h.handleMerchantInfo().data.balance > 0, true);

  const list = h.handleGoodsList({ page_no: 1, page_size: 50 }) as any;
  assert.equal(list.code, 0);
  assert.equal(list.data.count, 2);
  // 库存来自卡密池，不是 catalog 里手写的 stock
  assert.equal(list.data.list.find((g: any) => g.goods_no === 'T-POOL').stock, 2);
  assert.equal(list.data.list.find((g: any) => g.goods_no === 'T-SHARED').stock, 9999);

  // keyword 编码精准匹配
  const kw = h.handleGoodsList({ keyword: 'T-POOL', page_no: 1, page_size: 50 }) as any;
  assert.equal(kw.data.count, 1);

  // goods_type 1/2 都放行：两边枚举不一致时不能返回空
  assert.equal((h.handleGoodsList({ goods_type: 1, page_no: 1, page_size: 50 }) as any).data.count, 2);
  assert.equal((h.handleGoodsList({ goods_type: 3, page_no: 1, page_size: 50 }) as any).data.count, 0);

  assert.equal((h.handleGoodsList({ page_no: 1, page_size: 200 }) as any).code, 0); // 上限由管家控制
  assert.equal((h.handleGoodsList({}) as any).code, 1201);
});

test('purchase is idempotent per order_no and honours every documented error code', () => {
  const store = memoryStore();
  const h = createHandlers(store, { appId: CFG.appId });

  const first = h.handlePurchaseCreate({ order_no: 'O1', goods_no: 'T-POOL', buy_quantity: 1, max_amount: 1000 }) as any;
  assert.equal(first.code, 0);
  assert.deepEqual(Array.from(first.data.card_items, (c: any) => c.card_no), ['K1']);
  assert.equal(store.availableStock('T-POOL'), 1);

  // 重试：同一 order_no 必须返回同一结果，且不再扣卡
  const retry = h.handlePurchaseCreate({ order_no: 'O1', goods_no: 'T-POOL', buy_quantity: 1, max_amount: 1000 }) as any;
  assert.equal(retry.data.out_order_no, first.data.out_order_no);
  assert.equal(store.availableStock('T-POOL'), 1);

  assert.equal((h.handlePurchaseCreate({}) as any).code, 1201);
  assert.equal((h.handlePurchaseCreate({ order_no: 'O2', goods_no: 'NOPE', buy_quantity: 1 }) as any).code, 1100);
  assert.equal(
    (h.handlePurchaseCreate({ order_no: 'O3', goods_no: 'T-POOL', buy_quantity: 1, max_amount: 1 }) as any).code,
    1202,
  );
  // 库存只剩 1，要 5 张 → 1102
  assert.equal((h.handlePurchaseCreate({ order_no: 'O4', goods_no: 'T-POOL', buy_quantity: 5 }) as any).code, 1102);
  assert.equal((h.handleOrderDetail({ order_no: 'NOPE' }) as any).code, 1200);
  assert.equal((h.handleOrderDetail({ order_no: 'O1' }) as any).code, 0);
});

test('shared mode never consumes cards and is unlimited for the same content', () => {
  const store = memoryStore();
  const h = createHandlers(store, { appId: CFG.appId });

  for (let i = 0; i < 3; i++) {
    const r = h.handlePurchaseCreate({ order_no: `S${i}`, goods_no: 'T-SHARED', buy_quantity: 2 }) as any;
    assert.equal(r.code, 0);
    assert.equal(r.data.card_items.length, 2);
    assert.equal(r.data.card_items[0].card_pwd, '共享内容');
  }
  // 卡池条数不变
  assert.equal(store.cardPool()['T-SHARED'].length, 1);
  assert.equal(store.cardPool()['T-SHARED'][0].used, false);
});

test('goods list marks sold-out pools as off-shelf so buyers cannot order', () => {
  const store = memoryStore({ 'T-POOL': [{ card_no: 'K1', card_pwd: 'x', used: true }] });
  const h = createHandlers(store, { appId: CFG.appId });
  const g = (h.handleGoodsList({ page_no: 1, page_size: 50 }) as any).data.list.find(
    (x: any) => x.goods_no === 'T-POOL',
  );
  assert.equal(g.stock, 0);
  assert.equal(g.status, 2);
});

test('subscription endpoints are idempotent and answer without a data envelope', () => {
  const store = memoryStore();
  const h = createHandlers(store, { appId: CFG.appId });
  const args = { goods_type: 2, goods_no: 'T-POOL', token: 'tk', notify_url: 'https://example.com/n' };

  const sub = h.handleGoodsChangeSubscribe(args) as any;
  assert.equal(sub.code, 0);
  assert.equal('data' in sub, false, '官方 schema 只有 code + msg');

  const again = h.handleGoodsChangeSubscribe(args) as any;
  assert.equal(again.code, 0);
  const list = h.handleGoodsChangeSubscribeList({ page_no: 1, page_size: 10 }) as any;
  assert.equal(list.data.count, 1, '重复订阅不应入库两条');

  assert.equal((h.handleGoodsChangeSubscribe({ goods_no: 'T-POOL' }) as any).code, 1201);
  assert.equal((h.handleGoodsChangeSubscribe({ ...args, goods_no: 'NOPE' }) as any).code, 1100);
  assert.equal((h.handleGoodsChangeSubscribeList({ page_no: 1, page_size: 101 }) as any).code, 1201);
  assert.equal((h.handleGoodsChangeUnsubscribe({ goods_type: 2, goods_no: 'T-POOL', token: 'tk' }) as any).code, 0);
  assert.equal((h.handleGoodsChangeSubscribeList({ page_no: 1, page_size: 10 }) as any).data.count, 0);
  // 取消未订阅的也成功（幂等）
  assert.equal((h.handleGoodsChangeUnsubscribe({ goods_type: 2, goods_no: 'T-POOL', token: 'tk' }) as any).code, 0);
});

/* ---------------- HTTP 层 ---------------- */

async function withServer(store: any, fn: (base: string) => Promise<void>) {
  const server: http.Server = createServer({ config: { ...CFG }, store, handlers: createHandlers(store, { appId: CFG.appId }) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function signedCall(
  base: string,
  path: string,
  body: unknown = {},
  over: { mchId?: string; ts?: number; sign?: string; signOver?: string; method?: string } = {},
) {
  const raw = JSON.stringify(body);
  const ts = over.ts ?? Math.floor(Date.now() / 1000);
  const query = new URLSearchParams({
    mch_id: over.mchId ?? CFG.mchId,
    timestamp: String(ts),
    sign:
      over.sign ??
      genVsSign({
        appId: CFG.appId,
        appSecret: CFG.appSecret,
        mchId: over.mchId ?? CFG.mchId,
        mchSecret: CFG.mchSecret,
        timestamp: ts,
        bodyString: over.signOver ?? raw,
      }),
  });
  const res = await fetch(`${base}${path}?${query}`, {
    method: over.method ?? 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    ...(over.method === 'GET' ? {} : { body: raw }),
  });
  return { status: res.status, json: (await res.json()) as any };
}

test('http layer verifies signatures, tolerates GET probes and never 404s', async () => {
  const store = memoryStore();
  await withServer(store, async (base) => {
    const ok = await signedCall(base, '/goofish/open/info');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.code, 0);

    // 闲管家「应用连通性检测」先用 GET 探路径 —— 必须回 200 而不是 405
    const probe = await signedCall(base, '/goofish/goods/list', {}, { method: 'GET' });
    assert.equal(probe.status, 200);
    assert.equal(probe.json.code, 0);

    // 未签名 / 错签名 / 过期 / 错商户
    assert.equal((await signedCall(base, '/goofish/open/info', {}, { sign: 'a'.repeat(32) })).json.code, 401);
    assert.equal((await signedCall(base, '/goofish/open/info', {}, { mchId: 'other', sign: 'x' })).json.code, 1000);
    assert.equal(
      (await signedCall(base, '/goofish/open/info', {}, { ts: Math.floor(Date.now() / 1000) - 9999 })).json.code,
      408,
    );

    // 签名覆盖的是实际发送的字节：改了 body 必须失效
    const tampered = await signedCall(
      base,
      '/goofish/goods/detail',
      { goods_no: 'T-SHARED' },
      { signOver: JSON.stringify({ goods_no: 'T-POOL' }) },
    );
    assert.equal(tampered.json.code, 401);

    // 未知路径回 code=1（便于排查），不是 HTTP 404
    const unknown = await signedCall(base, '/goofish/nope', {});
    assert.equal(unknown.status, 200);
    assert.equal(unknown.json.code, 1);

    // 健康检查不需要签名
    const health = await fetch(`${base}/__health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  });
});

test('server refuses a non-POST on an unknown path with 405', async () => {
  const store = memoryStore();
  await withServer(store, async (base) => {
    const res = await fetch(`${base}/goofish/unknown`, { method: 'GET' });
    assert.equal(res.status, 405);
  });
});
