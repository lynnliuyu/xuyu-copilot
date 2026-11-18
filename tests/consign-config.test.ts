import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Operational helper is shared verbatim with the browser job.
import { buildConsignPlan, makeConsignPayload } from '../scripts/lib/consign-config.mjs';

const target = { code: 'BD-ONE', product_id: 101, kind_id: 201 };
const kind = { goods_no: target.code, app_id: 301, priority_sale: 2, goods_name: 'One' };
const consign = { status: 1, kind_way: 2, kind_id: 201, send_type: 1, send_dummy: 1,
  send_limit_min: 1, send_limit_max: 100, postscript: 'keep', send_statement: false,
  ex_url_status: 0, extra_config: '{"refund_revoke":{"enable":false}}', send_rule: 1,
  send_multiple: 1, again_send: false, template_id: 0 };
const detail = () => ({ product: { product_id: 101, item_id: 401, authorize_id: 501 },
  consign: { ...consign, status: 2, consign_id: 601 }, adjust_price: { status: 2 } });
// A template is only valid as the *verified* `kamiConsignInfo` response (consign + product).
const template = { consign, product: { product_id: 101, item_id: 401, authorize_id: 501 }, adjust_price: { status: 2 } };

test('exact resource code maps links; sold-out and mismatched cards are blocked', () => {
  const resources = { one: { draft_code: 'BD-ONE', baidu: { share_url: 'https://pan.baidu.com/s/abc', pwd: '1234' } } };
  const listings = { 'BD-ONE': { product_id: 101, state: 'on_sale' } };
  const state = { 'BD-ONE': { kind_id: 201 } };
  const cards = { 'BD-ONE': [{ used: false, card_pwd: 'https://pan.baidu.com/s/abc 提取码：1234' }] };
  assert.equal(buildConsignPlan(listings, state, cards, resources).targets.length, 1);
  assert.equal(buildConsignPlan(listings, state, { 'BD-ONE': [{ ...cards['BD-ONE'][0], used: true }] }, resources).targets.length, 0);
  assert.equal(buildConsignPlan(listings, state, { 'BD-ONE': [{ card_pwd: 'https://pan.baidu.com/s/wrong' }] }, resources).targets.length, 0);
});

test('refuses duplicate product mappings and untrusted link hosts', () => {
  assert.throws(() => buildConsignPlan({ 'BD-ONE': { product_id: 101, state: 'on_sale' } }, {}, {},
    { one: { draft_code: 'BD-ONE', baidu: { share_url: 'https://pan.baidu.com.evil.test/s/a' } } }), /不合法/);
  const link = 'https://pan.baidu.com/s/abc';
  const listings = Object.fromEntries(['ONE', 'TWO'].map(code => [code, { product_id: 101, state: 'on_sale' }]));
  const states = { ONE: { kind_id: 201 }, TWO: { kind_id: 202 } };
  const cards = { ONE: [{ card_pwd: link }], TWO: [{ card_pwd: link }] };
  const resources = { one: { draft_code: 'ONE', baidu: { share_url: link } },
    two: { draft_code: 'TWO', baidu: { share_url: link } } };
  assert.throws(() => buildConsignPlan(listings, states, cards, resources), /同一个商品/);
});

test('payload preserves per-product rules and binds exact platform IDs', () => {
  const d = detail();
  d.consign.postscript = 'existing item note';
  const body = makeConsignPayload(target, d, kind, template, 301);
  assert.deepEqual(body.product_id, [101]);
  assert.deepEqual(body.product_list, [{ authorize_id: 501, item_id: 401, product_id: 101 }]);
  assert.equal(body.kind_id, 201);
  assert.equal(body.postscript, 'existing item note');
  assert.equal(body.status, 1);
  assert.equal('goods_no' in body, false);
});

test('already configured is idempotent; conflicts and wrong source apps are blocked', () => {
  const d = detail(); d.consign.status = 1;
  assert.equal(makeConsignPayload(target, d, kind, template, 301), null);
  assert.equal(makeConsignPayload(target, { ...d, consign: { ...d.consign, kind_way: 4,
    app_id: 301, goods_no: 'BD-ONE' } }, kind, template, 301), null);
  assert.throws(() => makeConsignPayload(target, d, { ...kind, app_id: 999 }, template, 301), /关联/);
  assert.throws(() => makeConsignPayload(target, { ...d, consign: { ...d.consign, kind_id: 999 } }, kind, template, 301), /保留原配置/);
});

test('missing fields, unverified items and active pricing must not silently enable shipping', () => {
  assert.throws(() => makeConsignPayload(target, { ...detail(), product: { product_id: 101, item_id: 0 } }, kind, template, 301), /无法核对/);
  assert.throws(() => makeConsignPayload(target, { ...detail(), adjust_price: { status: 1 } }, kind, template, 301), /自动调价/);
  const d = detail(); delete (d.consign as Partial<typeof consign>).send_rule;
  assert.throws(() => makeConsignPayload(target, d, kind, template, 301), /缺少 send_rule/);
});

test('direct source mode preserves the working template and converts yuan to fen', () => {
  const sourceTemplate = { ...template, consign: { ...consign, kind_way: 4, app_id: 301,
    erp_id: 91, template_id: 701 } };
  const d = detail(); d.consign.consign_id = 0;
  const source = { goods_no: 'BD-ONE', title: 'source one', purchase_price: '2.88', stock: 9999 };
  const result = makeConsignPayload(target, d, { ...kind, priority_sale: 1 }, sourceTemplate, 301, source);
  assert.equal(result.kind_way, 4);
  assert.equal(result.kind_id, 0);
  assert.equal(result.goods_no, 'BD-ONE');
  assert.equal(result.goods_price, 288);
  assert.equal(result.template_id, 701);
  assert.throws(() => makeConsignPayload(target, d, kind, sourceTemplate, 301, { ...source, goods_no: 'BD-WRONG' }), /未核对/);
});

test('template must be a verified live configuration, never one of our own report rows', () => {
  const d = detail(); d.consign.consign_id = 0;
  // A previous round's report row (original machine config) lacks `product`; using it would
  // silently copy default settings that nobody ever verified.
  const ownRow = { mode: 'apply', results: [{ before: { ...d, product: undefined }, status: 'blocked' }] };
  assert.throws(() => makeConsignPayload(target, d, kind, ownRow, 301, null), /参考发货配置/);
  assert.throws(() => makeConsignPayload(target, d, kind, { ...template, consign: { ...consign, status: 2 } }, 301, null), /参考发货配置/);
  assert.equal(makeConsignPayload(target, d, kind, template, 301, null).kind_id, 201);
});
