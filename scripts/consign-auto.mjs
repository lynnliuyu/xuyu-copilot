#!/usr/bin/env node
/** Generate an authenticated-page API job; credentials remain in the official page. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildConsignPlan, makeConsignPayload, assertConsignTemplate } from './lib/consign-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const argv = process.argv.slice(2);
const opt = flag => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
if(argv.includes('--refresh')) {
  execFileSync(path.join(root,'node_modules/.bin/tsx'), [path.join(root,'scripts/consign-live-listings.ts')],
    { cwd: root, stdio: 'inherit' });
}
const codes = opt('--codes')?.split(',').filter(Boolean)
  ?? (opt('--codes-file') ? JSON.parse(fs.readFileSync(path.join(root, opt('--codes-file')), 'utf8')) : undefined);
const listingFile = opt('--listings-file') || 'out/consign-live-listings.json';
if(!fs.existsSync(path.join(root,listingFile))) throw new Error('先使用 --refresh 只读查询线上在售商品');
const plan = buildConsignPlan(read(listingFile), read('out/kami-auto-state.json'),
  read('packages/xgj-gateway/data/cards.json'), read('drafts/.resources.json'), { codes });
// This is the virtual source application; the ERP application does not serve links.
const appId = 1787570964481861;
const limit = Number(opt('--limit') || 0);
if (limit) plan.targets = plan.targets.slice(0, limit);
fs.mkdirSync(path.join(root, 'out'), { recursive: true });
fs.writeFileSync(path.join(root, 'out/consign-auto-plan.json'), JSON.stringify(plan, null, 2));

async function browserJob(plan, appId, makeConsignPayload, apply, assertConsignTemplate) {
  if (location.origin !== 'https://www.goofish.pro' || location.pathname === '/login') {
    throw new Error('请先在闲管家官方网站登录');
  }
  // Use the site's own AJAX client (v3 routes, request signing and response decryption).
  // No cookie/token extraction, no persistent credential, no order-send endpoints.
  let webpackRequire;
  const chunk = `consign_auto_${Date.now()}`;
  window.webpackJsonp.push([[chunk], { [chunk]: (module, exports, require) => { webpackRequire = require; } }, [[chunk]]]);
  const api = webpackRequire('./src/api/index.js').default;
  const report = { mode: apply ? 'apply' : 'dry', started_at: new Date().toISOString(),
    halted: false, plan_skipped: plan.skipped, template_source: null, results: [] };
  const previous = window.__consignAutoReport;
  if (apply && (!previous || previous.mode !== 'dry' || !previous.finished_at
      || plan.targets.some(t => !previous.results.some(r => r.code === t.code
        && r.product_id === t.product_id && r.kind_id === t.kind_id
        && (['ready', 'already-configured'].includes(r.status)
          || (r.status === 'blocked' && /保留原配置/.test(String(r.error)))))))) {
    throw new Error('必须先完成同一批商品的只读预演，且所有目标均核对通过');
  }
  const allowed = new Set(['kamiConsignInfo', 'getKAMInfo', 'getProductRechargeList', ...(apply ? ['kamiConsignSave'] : [])]);
  let nextRequestAt = 0;
  let nextWriteAt = 0;
  const call = async (method, body) => {
    const reserved = Math.max(Date.now(), nextRequestAt, method === 'kamiConsignSave' ? nextWriteAt : 0);
    nextRequestAt = reserved + 200; // At most five API starts per second across all workers.
    if(method === 'kamiConsignSave') nextWriteAt = reserved + 3500;
    if(reserved > Date.now()) await new Promise(resolve => setTimeout(resolve, reserved - Date.now()));
    return new Promise((resolve, reject) => {
    if (!allowed.has(method)) return reject(new Error('不允许的接口'));
    const timer = setTimeout(() => reject(new Error('接口超时，写入结果未知；停止后先读回，禁止盲重试')), 30000);
    api[method](body, { success: data => { clearTimeout(timer); resolve(data); },
      error: e => { clearTimeout(timer); reject(new Error(e.msg || '闲管家接口错误')); } });
    });
  };
  window.__consignAutoReport = report;
  const panel = document.createElement('pre');
  panel.id = 'consign-auto-report';
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#102238;color:#fff;padding:20px;max-height:50vh;overflow:auto;width:520px;white-space:pre-wrap';
  document.querySelector('#consign-auto-report')?.remove();
  document.body.appendChild(panel);
  const show = () => { panel.textContent = `发货配置 API · ${report.mode}\n${report.results.length}/${plan.targets.length}\n` +
    report.results.slice(-8).map(r => `${r.code}：${r.status}${r.error ? ' · ' + r.error : ''}`).join('\n'); };
  show();
  let template;
  // Find a working configuration via exact product IDs, never by similar-looking titles.
  const templateCandidates = [...plan.targets].sort((a, b) => Number(b.code === 'BD-ARTCRAFT') - Number(a.code === 'BD-ARTCRAFT'));
  for (const target of templateCandidates) {
    const d = await call('kamiConsignInfo', { send_type: 1, product_id: target.product_id, product_sku: 0 });
    if (Number(d.consign?.status) === 1 && [2, 4].includes(Number(d.consign.kind_way))) {
      assertConsignTemplate(d); template = d; break;
    }
  }
  if (!template) throw new Error('未找到已启用的参考发货配置；没有执行写操作');
  report.template_source = { product_id: Number(template.product.product_id),
    kind_way: Number(template.consign.kind_way), goods_no: template.consign.goods_no ?? null };
  let nextTarget = 0;
  const worker = async () => {
  while(nextTarget < plan.targets.length && !report.halted) {
    const target = plan.targets[nextTarget++];
    const row = { code: target.code, product_id: target.product_id, kind_id: target.kind_id };
    try {
      const [before, kindData, goods] = await Promise.all([
        call('kamiConsignInfo', { send_type: 1, product_id: target.product_id, product_sku: 0 }),
        Number(template.consign.kind_way) === 2 ? call('getKAMInfo', { kind_id: target.kind_id }) : Promise.resolve({}),
        Number(template.consign.kind_way) === 4
          ? call('getProductRechargeList', { app_id: appId, goods_type: 2, keyword: target.code })
          : Promise.resolve(null),
      ]);
      const kind = kindData.kind || kindData;
      let source;
      if(Number(template.consign.kind_way) === 4) {
        const matches = (goods.list || []).filter(g => String(g.goods_no) === target.code);
        if(matches.length !== 1) throw new Error('货源查询未找到唯一对应商品');
        source = matches[0];
      }
      const payload = makeConsignPayload(target, before, kind, template, appId, source);
      row.before = before;
      if (!payload) row.status = 'already-configured';
      else {
        row.payload = payload;
        if (!apply) row.status = 'ready';
        else {
          if(report.halted) throw new Error('同批任务出现错误，停止新写入');
          const planned = previous.results.find(r => r.code === target.code);
          if (JSON.stringify(planned.payload) !== JSON.stringify(payload)) {
            throw new Error('配置在预演后发生变化，请重新预演');
          }
          const saved = await call('kamiConsignSave', payload);
          if (saved.failure_count > 0) throw new Error(JSON.stringify(saved.failure_items));
          const after = await call('kamiConsignInfo', { send_type: 1, product_id: target.product_id, product_sku: 0 });
          row.after = after;
          if (Number(after.consign?.status) !== 1 || Number(after.consign.kind_way) !== Number(payload.kind_way)
              || (payload.kind_way === 2 && Number(after.consign.kind_id) !== target.kind_id)
              || (payload.kind_way === 4 && (Number(after.consign.app_id) !== appId
                  || String(after.consign.goods_no) !== target.code))) throw new Error('写入后读回不一致');
          row.status = 'verified';
        }
      }
    } catch (error) {
      row.status = 'blocked'; row.error = error.message;
      report.results.push(row); show();
      // Stop on all write errors, including unknown outcomes. Do not blindly carry on.
      if (apply || /登录|安全验证|超时|停止新写入/.test(error.message)) { report.halted = true; break; }
      continue;
    }
    report.results.push(row); show();
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  };
  await Promise.all(Array.from({ length: Math.min(apply ? 1 : 3, plan.targets.length) }, worker));
  report.finished_at = new Date().toISOString();
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob);
  link.download = `consign-auto-${report.mode}-${Date.now()}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 30000);
  show(); return report;
}

for (const apply of [false, true]) {
  const body = `(${browserJob.toString()})(${JSON.stringify(plan)},${appId},${makeConsignPayload.toString()},${apply},${assertConsignTemplate.toString()}).catch(error=>{console.error(error);const p=document.querySelector('#consign-auto-report');if(p)p.textContent+='\\n停止：'+error.message;});`;
  fs.writeFileSync(path.join(root, `out/consign-auto-${apply ? 'apply' : 'dry'}.js`), body);
}
console.log(JSON.stringify({ targets: plan.targets.length, skipped: plan.skipped, mode: '生成预演和执行脚本，未调用任何写接口',
  output: 'out/consign-auto-{plan.json,dry.js,apply.js}' }, null, 2));
