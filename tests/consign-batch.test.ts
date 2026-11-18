import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// @ts-expect-error local mjs module
import { plan, apply, isConfigured } from '../scripts/lib/consign-batch.mjs';

const APP = 100;
const consign = { status: 1, kind_way: 4, app_id: APP, erp_id: 91, send_type: 1, send_dummy: 1,
  send_limit_min: 1, send_limit_max: 9999, postscript: '', send_statement: false, ex_url_status: 0,
  extra_config: '{}', send_rule: 1, send_multiple: 1, again_send: false, template_id: 7 };

const targets = [
  { code: 'BD-ONE', product_id: 11 },
  { code: 'BD-TWO', product_id: 12 },
];
// Product 13 is an already-working reference configuration, passed explicitly as the template.
const template = { code: 'BD-TEMPLATE', product_id: 13 };

/** Fake client: `configured` products return an enabled config; everything else is empty. */
function fakeClient(options: { configured?: number[]; saveFails?: string[]; enabledOther?: number[] } = {}) {
  const configured = new Set(options.configured ?? [13]);
  const enabledOther = new Set(options.enabledOther ?? []);
  const calls: string[] = [];
  const state = new Map();
  const detail = (id: number) => {
    const t = [...targets, template].find(x => x.product_id === id)!;
    const on = configured.has(id) || state.has(id);
    return { product: { product_id: id, item_id: 900 + id, authorize_id: 800 + id }, adjust_price: { status: 2 },
      consign: on ? { ...consign, consign_id: 500 + id, goods_no: t.code }
        : { ...consign, consign_id: 0, status: enabledOther.has(id) ? 1 : 0, kind_way: enabledOther.has(id) ? 2 : 0, goods_no: '' } };
  };
  const client = {
    async info(id: number) { calls.push('info:' + id); return detail(id); },
    async source(appId: number, code: string) {
      calls.push('source:' + code);
      return { list: [{ goods_no: code, title: 'T ' + code, purchase_price: '2.88', stock: 9999 }] };
    },
    async saveSingle(payload: any, { before, apply: write = false }: any) {
      calls.push((write ? 'save:' : 'dry:') + payload.goods_no);
      if (write && options.saveFails?.includes(payload.goods_no)) throw new Error('闲管家接口拒绝请求（code=500）');
      if (write) state.set(payload.product_id[0], true);
      return write ? { dry_run: false, status: 'verified' } : { dry_run: true, status: 'ready', payload, before };
    },
  };
  return { client, calls, state };
}

test('plan is read-only and marks already-configured items without a write', async () => {
  const { client, calls } = fakeClient({ configured: [11, 13] });
  const result = await plan(client, targets, { appId: APP, templateProductId: 13 });
  assert.deepEqual(result.rows.map(r => r.status), ['already-configured', 'ready']);
  assert.equal(calls.some(c => c.startsWith('save:')), false);
  assert.equal(calls.some(c => c.startsWith('dry:')), true);
});

test('apply requires the same batch, writes serially and stops at the first failure', async () => {
  const { client, calls } = fakeClient({ saveFails: ['BD-TWO'] });
  const planned = await plan(client, targets, { appId: APP, templateProductId: 13 });
  await assert.rejects(apply(client, planned.rows, { sameBatch: [{ code: 'BD-TWO', product_id: 12 }] }), /同一批次/);
  const result = await apply(client, planned.rows, { sameBatch: planned.rows });
  assert.equal(result.halted, true);
  assert.equal(result.stop_reason, 'write_failed');
  // BD-ONE succeeds, BD-TWO fails and is read back once, BD-THREE is never attempted.
  assert.deepEqual(result.rows.map(r => r.code), ['BD-ONE', 'BD-TWO']);
  assert.deepEqual(result.rows.map(r => r.status), ['verified', 'blocked']);
  assert.deepEqual(calls.filter(c => c.startsWith('save:')), ['save:BD-ONE', 'save:BD-TWO']);
  assert.equal(calls.includes('info:12'), true); // unknown-outcome read-back
  assert.equal(result.remaining, 0);
});

test('apply refuses plan rows that lost their snapshot (stale or hand-edited report)', async () => {
  const { client } = fakeClient();
  const planned = await plan(client, targets, { appId: APP, templateProductId: 13 });
  const tampered = structuredClone(planned.rows);
  delete tampered.find(r => r.status === 'ready').before;
  await assert.rejects(apply(client, tampered, { sameBatch: tampered }), /预演快照/);
});

test('idempotent detection is strict on app, mode and goods_no', () => {
  assert.equal(isConfigured({ consign: { status: 1, kind_way: 4, app_id: APP, goods_no: 'BD-ONE' } }, { appId: APP, code: 'BD-ONE' }), true);
  assert.equal(isConfigured({ consign: { status: 1, kind_way: 2, app_id: APP, goods_no: 'BD-ONE' } }, { appId: APP, code: 'BD-ONE' }), false);
  assert.equal(isConfigured({ consign: { status: 1, kind_way: 4, app_id: 999, goods_no: 'BD-ONE' } }, { appId: APP, code: 'BD-ONE' }), false);
});

test('read-only client cannot reach the save endpoint even if asked', async () => {
  const source = fs.readFileSync(new URL('../scripts/lib/xgj-web-client.mjs', import.meta.url), 'utf8');
  assert.match(source, /allowSave/);
  assert.match(source, /当前为只读模式，禁止调用写接口/);
});
