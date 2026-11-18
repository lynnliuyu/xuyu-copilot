#!/usr/bin/env node
import { mkdir, writeFile, readFile, chmod, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import QRCode from 'qrcode';
import { execFileSync } from 'node:child_process';
import { CACHE, installRuntime, loadRuntime } from './lib/xgj-web-runtime.mjs';
import { XgjWebClient, readSession, saveSession } from './lib/xgj-web-client.mjs';
import { makeConsignPayload, buildConsignPlan } from './lib/consign-config.mjs';
import { plan as planBatch, apply as applyBatch } from './lib/consign-batch.mjs';

const APP_ID = 1787570964481861; // virtual source app (bd-to-xy); never the ERP app
const option = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? fallback : (process.argv[i + 1] ?? true);
};

/** Enumerate real on-sale products, then map them to local ledger codes (read-only). */
async function loadTargets({ refresh, codesFile, limit }) {
  if (refresh) {
    execFileSync(process.execPath, [resolve('node_modules/.bin/tsx'), resolve('scripts/consign-live-listings.ts')],
      { cwd: resolve('.'), stdio: 'inherit' });
  }
  const readJson = async p => JSON.parse(await readFile(resolve(p), 'utf8'));
  const listings = await readJson(option('listings-file', 'out/consign-live-listings.json'));
  const kinds = await readJson('out/kami-auto-state.json');
  const cards = await readJson('packages/xgj-gateway/data/cards.json');
  const resources = await readJson('drafts/.resources.json');
  const codes = codesFile ? JSON.parse(await readFile(resolve(String(codesFile)), 'utf8')) : undefined;
  const built = buildConsignPlan(listings, kinds, cards, resources, { codes });
  if (!built.targets.length) throw new Error('没有任何可配置目标');
  return { targets: limit ? built.targets.slice(0, Number(limit)) : built.targets, skipped: built.skipped };
}

async function main() {
  const [command = 'help', id, code, templateId] = process.argv.slice(2);
  if (command === 'setup') {
    await installRuntime();
    console.log('官方签名/加密运行库已安装，SHA-256 校验通过。');
    return;
  }
  if (command === 'plan' || command === 'apply') {
    const runtime = await loadRuntime();
    const tasks = 'npm run consign:api -- plan --refresh [--codes-file <codes.json>]'; 
    const client = new XgjWebClient({ runtime, token: await readSession(), allowSave: command === 'apply' });
    if (command === 'apply' && !process.argv.includes('--yes')) {
      // A bare `apply` must not be able to write; tell the operator the exact confirmation.
      throw new Error('apply 是写操作，必须带 --yes 并指定同一批次的 --batch。先预演：' + tasks);
    }
    if (command === 'plan') {
      const target = await loadTargets({ refresh: process.argv.includes('--refresh'),
        codesFile: option('codes-file'), limit: option('limit') });
      const templateProductId = option('template-product');
      const result = await planBatch(client, target.targets, { appId: APP_ID,
        templateProductId: templateProductId && Number(templateProductId) });
      const counts = result.rows.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {});
      const output = resolve(option('out', 'out/consign-batch-plan.json'));
      await mkdir(resolve('out'), { recursive: true });
      await writeFile(output, JSON.stringify({ checked_at: new Date().toISOString(), ...result,
        skipped: target.skipped, counts }, null, 2) + '\n', { mode: 0o600 });
      console.log(JSON.stringify({ mode: 'plan', counts, total: result.rows.length, output }));
      console.log('预演只读，未调用 kamiConsignSave。确认后执行 apply --batch ' + output + ' --yes');
      return;
    }
    // Apply works only from a saved plan report: never from a freshly rebuilt target list.
    const batchFile = option('batch');
    if (typeof batchFile !== 'string') throw new Error('apply 需要 --batch <plan.json>（同一批次的预演报告）');
    const saved = JSON.parse(await readFile(resolve(batchFile), 'utf8'));
    if (saved.mode !== 'plan' || !Array.isArray(saved.rows) || !saved.rows.length) {
      throw new Error('--batch 不是有效的 plan 报告');
    }
    const result = await applyBatch(client, saved.rows, { sameBatch: saved.rows });
    const output = resolve(option('out', 'out/consign-batch-apply.json'));
    await writeFile(output, JSON.stringify({ checked_at: new Date().toISOString(), ...result }, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ mode: 'apply', processed: result.processed, halted: result.halted,
      stop_reason: result.stop_reason, remaining: result.remaining, output }));
    if (result.halted) process.exitCode = 1;
    return;
  }
  if (!['login', 'info', 'preview'].includes(command)) {
    console.log(`用法：consign:api setup | login | info <product_id> | preview <product_id> <goods_no> <template_product_id>
      plan  [--refresh] [--codes-file <json>] [--limit N] [--template-product <id>]   只读预演，默认不写
      apply --batch <plan.json> --yes [--refresh] [--codes-file <json>]              写操作，必须显式确认`);
    return;
  }
  const runtime = await loadRuntime();
  if (command === 'login') {
    const client = new XgjWebClient({ runtime });
    const qr = await client.createLoginQr();
    if (typeof qr?.qrcode_url !== 'string' || typeof qr?.qrcode_token !== 'string') throw new Error('登录二维码响应格式变化');
    const url = new URL(qr.qrcode_url);
    if (url.protocol !== 'https:') throw new Error('登录二维码不是 HTTPS 地址');
    await mkdir(CACHE, { recursive: true, mode: 0o700 });
    const image = CACHE + 'login.png';
    try {
      await QRCode.toFile(image, qr.qrcode_url, { width: 360, margin: 3, errorCorrectionLevel: 'M' });
      await chmod(image, 0o600);
      console.log(`请用已绑定闲管家的微信扫码并确认：${image}`);
      console.log('等待扫码，最长 180 秒；全程由 Node.js 调用接口。');
      const deadline = Date.now() + 180000;
      let previous = -1;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        const result = await client.checkLoginQr(qr.qrcode_token);
        const status = Number(result?.login_status);
        if (status !== previous) console.log(['等待扫码', '已扫码，等待确认', '已确认', '二维码已过期'][status] || '未知扫码状态');
        previous = status;
        if (status === 3) throw new Error('二维码已过期，请重新执行 login');
        if (status === 2) {
          const token = await client.finishLogin(result.login_token);
          await saveSession(token);
          console.log('登录成功，凭证已保存到忽略目录，文件权限 600。');
          return;
        }
      }
      throw new Error('等待扫码超时，请重新执行 login');
    } finally { await unlink(image).catch(() => {}); }
  } else {
    if (!/^\d+$/.test(id || '')) throw new Error('info 需要一个正整数 product_id');
    const client = new XgjWebClient({ runtime, token: await readSession() });
    const detail = await client.info(Number(id));
    if (Number(detail?.product?.product_id) !== Number(id)) throw new Error('响应商品 ID 与查询目标不一致');
    if (command === 'preview') {
      if (!code || !/^\d+$/.test(templateId || '')) throw new Error('preview 需要 goods_no 和已验证的参考商品 ID');
      const template = await client.info(Number(templateId));
      if (Number(template?.consign?.kind_way) !== 4) throw new Error('参考商品必须是直接货源模式');
      const appId = Number(template.consign.app_id);
      const matches = (await client.source(appId, code))?.list?.filter(item => item.goods_no === code) || [];
      if (matches.length !== 1) throw new Error('未找到精确唯一的货源商品');
      const payload = makeConsignPayload({ code, product_id: Number(id), kind_id: 0 }, detail, null, template, appId, matches[0]);
      const result = payload ? await client.saveSingle(payload, { before: detail }) : { dry_run: true, status: 'already-configured' };
      const output = resolve('out/consign-api-preview.json');
      await mkdir(resolve('out'), { recursive: true });
      await writeFile(output, JSON.stringify({ checked_at: new Date().toISOString(), product_id: Number(id), code, ...result }, null, 2) + '\n', { mode: 0o600 });
      console.log(`预演结果：${result.status}；未保存配置。报告：${output}`);
      return;
    }
    const c = detail.consign || {};
    const report = { read_only: true, checked_at: new Date().toISOString(), product_id: Number(id),
      item_id: detail.product.item_id, status: c.status, kind_way: c.kind_way, app_id: c.app_id,
      goods_no: c.goods_no, consign_id: c.consign_id };
    const output = resolve('out/consign-api-info.json');
    await mkdir(resolve('out'), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
    console.log(`只读核验报告：${output}`);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
