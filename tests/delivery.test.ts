/**
 * 发货排查聚合 + 本地预检 的回归测试（纯本地，不联网、不写线上）。
 *
 * 两条验证线：
 *   1. deliverySnapshot 能把「店铺 / 发货设置 / 库存 / 最近订单」聚合成正确结构；
 *      缺 consign 事实时如实标待核（null），不编造「已启用」。
 *   2. deliveryPreflight 对异常样本（卡空 / 未绑店 / 台账缺失）给出 blocker/warn，
 *      对正常样本给通过；全程不调任何写接口。
 *
 * 数据用合成 fixture（隔离临时目录），与真实运营数据零接触。
 *
 * ⚠️ DRAFTS_DIR 是模块级常量，在 delivery.ts 首次 import 时求值并固定，
 *    因此整个测试进程必须只用一个共享临时目录（before 里建好），
 *    不能用 beforeEach 换目录（换了也读不到，还会被删）。
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp = '';
let dataDirS = '';
let draftsDirS = '';

function write(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 1), 'utf8');
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xgj-delivery-'));
  dataDirS = path.join(tmp, 'data');
  draftsDirS = path.join(tmp, 'drafts');
  fs.mkdirSync(dataDirS, { recursive: true });
  fs.mkdirSync(draftsDirS, { recursive: true });
  process.env.XGJ_DATA_DIR = dataDirS;
  process.env.XGJ_DRAFTS_DIR = draftsDirS;
});

after(() => {
  delete process.env.XGJ_DATA_DIR;
  delete process.env.XGJ_DRAFTS_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 每个测试前重建数据文件（同一目录，mtime 变化会触发 store 缓存失效） */
beforeEach(() => {
  const now = Math.floor(Date.now() / 1000);
  write(path.join(dataDirS, 'catalog.json'), {
    merchant: { mch_id: '1787570964481861', name: '合成商', balance: 999999 },
    goods: [
      { goods_no: 'BD-OK', goods_type: 2, goods_name: '正常商品', price: 188, stock: 9999, status: 1, update_time: now, stock_mode: 'pool' },
      { goods_no: 'BD-EMPTY', goods_type: 2, goods_name: '卡空商品', price: 188, stock: 9999, status: 1, update_time: now, stock_mode: 'pool' },
      { goods_no: 'BD-UNMAPPED', goods_type: 2, goods_name: '未绑店商品', price: 188, stock: 9999, status: 1, update_time: now, stock_mode: 'pool' },
    ],
  });
  write(path.join(dataDirS, 'cards.json'), {
    'BD-OK': [{ card_pwd: 'https://pan.example/s/ok', used: true }, { card_pwd: 'https://pan.example/s/ok2', used: false }],
    'BD-EMPTY': [],
    'BD-UNMAPPED': [{ card_pwd: 'https://pan.example/s/un', used: false }],
  });
  write(path.join(dataDirS, 'orders.json'), {
    'O-001': {
      out_order_no: 'X', order_no: 'O-001', order_status: 20, order_amount: 188,
      order_time: now - 86400, goods_no: 'BD-OK', buy_quantity: 1,
      card_items: [{ card_pwd: 'https://pan.example/s/ok' }],
    },
  });
  write(path.join(dataDirS, 'subscriptions.json'), {});
  // 草稿归属：BD-OK / BD-EMPTY → 顺和；BD-UNMAPPED 无草稿
  write(path.join(draftsDirS, 'BD-OK.json'), { code: 'BD-OK', publish_shop: [{ user_name: '顺和服饰平价超市', title: 'x' }] });
  write(path.join(draftsDirS, 'BD-EMPTY.json'), { code: 'BD-EMPTY', publish_shop: [{ user_name: '顺和服饰平价超市', title: 'x' }] });
  write(path.join(draftsDirS, '.listings.json'), {
    'BD-OK': { product_id: 111, state: 'on_sale', updated_at: '2026-11-01 10:00:00' },
    'BD-EMPTY': { product_id: 222, state: 'on_sale', updated_at: '2026-11-01 10:00:00' },
  });
});

async function loadDelivery() {
  return await import('../packages/xgj-admin/src/delivery');
}

test('deliverySnapshot：聚合店铺/库存/最近订单，consign 缺数据标 null 不编造', async () => {
  const { deliverySnapshot } = await loadDelivery();
  const snap = deliverySnapshot({ byProduct: {} });

  assert.equal(snap.meta.realData, true);
  assert.equal(snap.goods.length, 3);

  const ok = snap.goods.find((g) => g.goods_no === 'BD-OK')!;
  assert.equal(ok.shop, '顺和服饰平价超市');
  assert.equal(ok.consign_active, null); // 没注入事实 → 不能假装已启用
  assert.equal(ok.cards_total, 2);
  assert.equal(ok.cards_used, 1);
  assert.equal(ok.cards_free, 1);
  assert.equal(ok.last_order_no, 'O-001');
  assert.equal(ok.product_id, 111);

  const empty = snap.goods.find((g) => g.goods_no === 'BD-EMPTY')!;
  assert.equal(empty.cards_free, 0);
  assert.equal(empty.consign_active, null);

  // byShop：顺和 2 件，未知 1 件
  assert.equal(snap.byShop['顺和服饰平价超市']?.total, 2);
  assert.equal(snap.byShop['(未知)']?.total, 1);
  // candidates：有卡未发的商品
  assert.ok(snap.candidates.some((c) => c.goods_no === 'BD-UNMAPPED'));
});

test('deliverySnapshot：注入 consign 事实后正确标记启用/未启用', async () => {
  const { deliverySnapshot } = await loadDelivery();
  const snap = deliverySnapshot({
    byProduct: {
      '111': { active: true, kind_way: 4, template_id: 1787619864662213, at: '2026-10-20T00:00:00Z' },
      '222': { active: false, at: '2026-10-29T00:00:00Z' },
    },
  });

  assert.equal(snap.meta.consignFactsInjected, true);
  assert.equal(snap.goods.find((g) => g.goods_no === 'BD-OK')!.consign_active, true);
  assert.equal(snap.goods.find((g) => g.goods_no === 'BD-OK')!.template_id, 1787619864662213);
  assert.equal(snap.goods.find((g) => g.goods_no === 'BD-EMPTY')!.consign_active, false);
  // 顺和店：BD-OK 已启用、BD-EMPTY 明确未启用 → 无待核；待核的 BD-UNMAPPED 落在未知店
  assert.equal(snap.byShop['顺和服饰平价超市']?.consignActive, 1);
  assert.equal(snap.byShop['顺和服饰平价超市']?.consignUnknown, 0);
  assert.equal(snap.byShop['(未知)']?.consignUnknown, 1);
});

test('deliveryPreflight：正常样本通过，异常样本给 blocker/warn', async () => {
  const { deliveryPreflight } = await loadDelivery();

  const ok = deliveryPreflight('BD-OK');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.issues, []);

  const empty = deliveryPreflight('BD-EMPTY');
  assert.equal(empty.ok, false);
  assert.ok(empty.issues.some((i) => i.level === 'blocker' && i.field === 'cards'));
  assert.ok(empty.issues.some((i) => i.level === 'info' && i.field === 'orders'));

  const unmapped = deliveryPreflight('BD-UNMAPPED');
  assert.equal(unmapped.ok, false);
  assert.ok(unmapped.issues.some((i) => i.level === 'warn' && i.field === 'shop'));    // 未绑店
  assert.ok(unmapped.issues.some((i) => i.level === 'warn' && i.field === 'listing')); // 台账无 product_id
});

test('deliveryPreflight：商品不存在时返回空问题且不抛错', async () => {
  const { deliveryPreflight } = await loadDelivery();
  const r = deliveryPreflight('BD-NOPE');
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues, []);
  assert.equal(r.goods_no, 'BD-NOPE');
});