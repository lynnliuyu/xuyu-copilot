/**
 * 配置方案（generate / save / list / load）的回归测试。
 *
 * 重点验证三件事：
 *   1. 方案只从**本地台账**生成：拟改字段、风险、证据（回调已证实 / 绑定未证实）正确；
 *   2. 确认后只落**本地文件**（临时目录），不调用任何线上接口；
 *   3. id 校验与「空计划」拒绝——防止误触写出奇怪文件。
 *
 * 用合成 fixture，与真实运营数据零接触。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp = '';
let dataDirS = '';
let draftsDirS = '';
let plansDirS = '';

function write(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 1), 'utf8');
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xgj-delivery-plan-'));
  dataDirS = path.join(tmp, 'data');
  draftsDirS = path.join(tmp, 'drafts');
  plansDirS = path.join(tmp, 'plans');
  fs.mkdirSync(dataDirS, { recursive: true });
  fs.mkdirSync(draftsDirS, { recursive: true });
  process.env.XGJ_DATA_DIR = dataDirS;
  process.env.XGJ_DRAFTS_DIR = draftsDirS;
  process.env.XGJ_DELIVERY_PLANS_DIR = plansDirS;

  const now = Math.floor(Date.now() / 1000);
  write(path.join(dataDirS, 'catalog.json'), {
    merchant: { mch_id: '1787570964481861', balance: 999999 },
    goods: [
      { goods_no: 'BD-OK', goods_type: 2, goods_name: '正常商品', price: 188, stock: 9999, status: 1, update_time: now, stock_mode: 'pool' },
      { goods_no: 'BD-EMPTY', goods_type: 2, goods_name: '卡空商品', price: 188, stock: 9999, status: 1, update_time: now, stock_mode: 'pool' },
    ],
  });
  write(path.join(dataDirS, 'cards.json'), {
    'BD-OK': [{ card_pwd: 'https://pan.example/s/ok', used: true }, { card_pwd: 'https://pan.example/s/ok2', used: false }],
    'BD-EMPTY': [],
  });
  write(path.join(dataDirS, 'orders.json'), {
    'O-001': {
      out_order_no: 'X', order_no: 'O-001', order_status: 20, order_amount: 188,
      order_time: now - 86400, goods_no: 'BD-OK', buy_quantity: 1,
      card_items: [{ card_pwd: 'https://pan.example/s/ok' }],
    },
  });
  write(path.join(dataDirS, 'subscriptions.json'), {});
  write(path.join(draftsDirS, 'BD-OK.json'), { code: 'BD-OK', publish_shop: [{ user_name: '顺和服饰平价超市', title: 'x' }] });
  write(path.join(draftsDirS, 'BD-EMPTY.json'), { code: 'BD-EMPTY', publish_shop: [{ user_name: '顺和服饰平价超市', title: 'x' }] });
  write(path.join(draftsDirS, '.listings.json'), {
    'BD-OK': { product_id: 111, state: 'on_sale', updated_at: '2026-11-01 10:00:00' },
    'BD-EMPTY': { product_id: 222, state: 'on_sale', updated_at: '2026-11-01 10:00:00' },
  });
});

after(() => {
  delete process.env.XGJ_DATA_DIR;
  delete process.env.XGJ_DRAFTS_DIR;
  delete process.env.XGJ_DELIVERY_PLANS_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function loadPlanMod() {
  return await import('../packages/xgj-admin/src/delivery-plan');
}

test('generateDeliveryPlan：按店铺过滤、拟改字段与证据标注正确', async () => {
  const { generateDeliveryPlan } = await loadPlanMod();
  const plan = generateDeliveryPlan({ shop: '顺和服饰平价超市' }, {
    byProduct: { '111': { active: true, kind_way: 4, template_id: 1787619864662213, at: 'x' } },
  });

  assert.equal(plan.scope.shop, '顺和服饰平价超市');
  assert.equal(plan.summary.total, 2);

  const ok = plan.targets.find((t) => t.goods_no === 'BD-OK')!;
  assert.equal(ok.status, 'ready');
  assert.equal(ok.evidence.gatewayCallback, 'proven'); // 本地台账有出卡记录
  assert.equal(ok.evidence.onlineBinding, 'verified'); // 注入了已核实事实
  // 拟改字段：kind_way=4、goods_no 一致
  const kw = ok.fields.find((f) => f.field === 'kind_way')!;
  assert.equal(kw.proposed.includes('4'), true);
  const gn = ok.fields.find((f) => f.field === 'goods_no')!;
  assert.equal(gn.proposed, 'BD-OK');
  assert.equal(ok.fields.find((f) => f.field === 'template_id')!.proposed, '1787619864662213');

  const empty = plan.targets.find((t) => t.goods_no === 'BD-EMPTY')!;
  assert.equal(empty.status, 'blocked'); // 卡空是 blocker
  assert.equal(empty.evidence.gatewayCallback, 'none');
});

test('generateDeliveryPlan：缺 consign 事实时绑定标未证实，不编造', async () => {
  const { generateDeliveryPlan } = await loadPlanMod();
  const plan = generateDeliveryPlan({ shop: null, codes: ['BD-OK'] }, { byProduct: {} });
  const t = plan.targets[0];
  assert.equal(t.evidence.onlineBinding, 'unverified');
  assert.equal(t.fields.find((f) => f.field === 'kind_way')!.source, 'unknown');
});

test('savePlan：只写本地文件，list/load 可回看', async () => {
  const { generateDeliveryPlan, savePlan, listPlans, loadPlan, plansDir } = await loadPlanMod();
  const plan = generateDeliveryPlan({ shop: '顺和服饰平价超市' }, { byProduct: {} });
  const saved = savePlan(plan);
  assert.equal(saved.ok, true);
  if (saved.ok) {
    assert.ok(saved.path.startsWith(plansDir()), '计划必须落在本地 plans 目录');
    assert.ok(fs.existsSync(saved.path), '文件应已落盘');
    const got = loadPlan(saved.id);
    assert.ok(got);
    assert.equal(got!.id, plan.id);
    assert.equal(got!.targets.length, plan.targets.length);
  }
  const list = listPlans();
  assert.ok(list.some((p) => p.id === plan.id));
});

test('savePlan：空计划与非法 id 被拒（防误触写出怪文件）', async () => {
  const { generateDeliveryPlan, savePlan, loadPlan } = await loadPlanMod();
  const emptyPlan = generateDeliveryPlan({ shop: null, codes: ['BD-NOT-EXIST'] }, { byProduct: {} });
  assert.equal(emptyPlan.targets.length, 0);
  const r1 = savePlan(emptyPlan);
  assert.equal(r1.ok, false);

  const bad = generateDeliveryPlan({ shop: null, codes: ['BD-OK'] }, { byProduct: {} });
  bad.id = '../evil';
  assert.equal(savePlan(bad).ok, false);
  assert.equal(loadPlan('../evil'), null);
  assert.equal(loadPlan('plan-xxx-abc'), null);
});
