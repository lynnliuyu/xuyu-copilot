import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
// @ts-expect-error Shared browser helper.
import { makeConsignPayload, assertConsignTemplate } from '../scripts/lib/consign-config.mjs';

test('browser job: dry-run never writes, apply requires preflight and reads back every save', async () => {
  const source = fs.readFileSync(new URL('../scripts/consign-auto.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function browserJob('), source.indexOf('\nfor (const apply of'));
  const targets = [
    { code: 'BD-ARTCRAFT', product_id: 101, kind_id: 201 },
    { code: 'BD-TWO', product_id: 102, kind_id: 202 },
  ];
  const config = { status: 1, kind_way: 2, kind_id: 201, send_type: 1, send_dummy: 1,
    send_limit_min: 1, send_limit_max: 100, postscript: '', send_statement: false,
    ex_url_status: 0, extra_config: '{}', send_rule: 1, send_multiple: 1, again_send: false, template_id: 0 };
  const remote = new Map(targets.map((t, i) => [t.product_id, {
    product: { product_id: t.product_id, item_id: 400 + i, authorize_id: 501 },
    consign: { ...config, kind_id: t.kind_id, consign_id: 600 + i, status: i ? 2 : 1 },
    adjust_price: { status: 2 },
  }]));
  const requests: Array<{ method: string; body: any }> = [];
  const api = Object.fromEntries(['kamiConsignInfo', 'getKAMInfo', 'kamiConsignSave'].map(method => [method,
    (input: any, cb: any) => {
      requests.push({ method, body: input });
      if (method === 'kamiConsignInfo') cb.success(structuredClone(remote.get(input.product_id)));
      if (method === 'getKAMInfo') cb.success({ kind_id: input.kind_id,
        goods_no: targets.find(t => t.kind_id === input.kind_id)!.code,
        app_id: 301, priority_sale: 2, goods_name: 'verified product' });
      if (method === 'kamiConsignSave') {
        remote.get(input.product_id[0])!.consign = { ...input };
        cb.success({ failure_count: 0 });
      }
    }]));
  let panel: any;
  const window: any = { webpackJsonp: { push(parts: any[]) {
    Object.values(parts[1]).forEach((fn: any) => fn({}, {}, () => ({ default: api })));
  } } };
  const context = { window, location: { origin: 'https://www.goofish.pro', pathname: '/sale/statistics' },
    document: { createElement: () => ({ style: {}, click() {}, remove() {} }), querySelector: () => panel,
      body: { appendChild(element: any) { panel = element; } } },
    setTimeout: (fn: () => void, ms: number) => { const timer = setTimeout(fn, ms === 350 ? 0 : ms); timer.unref(); return timer; },
    clearTimeout, Blob, URL: { createObjectURL: () => 'blob:report', revokeObjectURL() {} },
  };
  const run = vm.runInNewContext(`${body}; browserJob`, context);
  const plan = { targets, skipped: [] };
  await assert.rejects(run(plan, 301, makeConsignPayload, true, assertConsignTemplate), /预演/);
  const dry = await run(plan, 301, makeConsignPayload, false, assertConsignTemplate);
  assert.equal(dry.template_source?.product_id, 101); // reuses the idempotent, already-working config
  assert.equal(dry.halted, false);
  assert.deepEqual(Array.from(dry.results, (r: any) => r.status), ['already-configured', 'ready']);
  assert.equal(requests.filter(r => r.method === 'kamiConsignSave').length, 0);
  const applied = await run(plan, 301, makeConsignPayload, true, assertConsignTemplate);
  assert.deepEqual(Array.from(applied.results, (r: any) => r.status), ['already-configured', 'verified']);
  const saves = requests.filter(r => r.method === 'kamiConsignSave');
  assert.equal(saves.length, 1);
  assert.equal(saves[0].body.kind_id, 202);
  const last = requests.at(-1)!;
  assert.equal(last.method, 'kamiConsignInfo');
  assert.equal(last.body.product_id, 102);
});
