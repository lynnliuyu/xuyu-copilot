#!/usr/bin/env node
/**
 * 欠单补发（dummy/send 标记已发货）。
 *
 * ⚠️ 语义边界（读清楚再跑）：
 *   `dummy/send` 只是**改订单状态为已发货**，它**不带内容**——闲管家没有给买家发消息的接口，
 *   所以本脚本**不会**把网盘链接送到买家聊天窗口。链接必须另外人工发（`--copy` 出文本）。
 *
 * 只处理 `order_status=12`（待发货、`consign_time=0`）且 `order/kam/list` 为空的单。
 * `status=21` 已发货 / `22` 已完成 / `23` 退款 一律跳过，不动。
 *
 * 用法：
 *   npx tsx scripts/resend-owed.ts                      只读：列出可补发订单 + 卡密文本
 *   npx tsx scripts/resend-owed.ts --dry                同上（生成预演报告 out/resend-owed-dry.json）
 *   npx tsx scripts/resend-owed.ts --send --order <no>  单件灰度：发一单并读回
 *   npx tsx scripts/resend-owed.ts --send --all --yes   全部待发货单（串行、间隔 ≥3.5s、失败即停）
 *   npx tsx scripts/resend-owed.ts --copy               打印可直接复制给买家的补发文本
 */
import fs from 'node:fs';
import { listOrders, getOrderKamiList, dummySend } from '../packages/goofish-adapter/src/api';
import { cardPool, loadCatalog, isShared } from '../packages/xgj-gateway/src/store';

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const val = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const SEND = flag('send');
const ALL = flag('all');
const CONFIRMED = flag('yes');
const SINGLE = val('order');
const DAYS = Number(val('days') || 90);
const INTERVAL = 3500;

/** 待发货 = 12；只认这一个状态（REFERENCE 状态码表，consign_time=0） */
const PENDING = 12;

const byOuter = new Map();
for (const [code, row] of Object.entries(JSON.parse(fs.readFileSync('drafts/.listings.json', 'utf8')))) {
  if (row?.product_id) byOuter.set(Number(row.product_id), code);
}

function cardText(code) {
  const catalog = loadCatalog();
  const goods = catalog.goods.find(g => g.goods_no === code);
  const pool = cardPool()[code] ?? [];
  if (!goods || !pool.length) return null;
  if (!isShared(goods)) {
    // 一次性卡：发出去就会消耗，必须确认还有未用
    const open = pool.filter(c => !c.used);
    if (!open.length) return null;
    return open[0].card_pwd;
  }
  return pool[0].card_pwd;
}

async function collect() {
  const since = Math.floor(Date.now() / 1000) - DAYS * 86400;
  const orders = [];
  for (let page = 1; page <= 20; page++) {
    const r = await listOrders({ page_no: page, page_size: 50, order_status: PENDING });
    const list = r.list ?? [];
    if (!list.length) break;
    for (const o of list) {
      const t = Number(o.order_time ?? o.pay_time ?? 0);
      if (t < since) continue;
      orders.push(o);
    }
    if (list.length < 50) break;
  }
  const owed = [];
  for (const o of orders) {
    if (Number(o.order_status) !== PENDING) continue;
    const kam = await getOrderKamiList(o.order_no);
    if (kam.length) continue;
    const pid = Number(o.goods?.product_id);
    const code = o.goods?.outer_id || byOuter.get(pid);
    owed.push({
      order_no: o.order_no, product_id: pid, item_id: o.goods?.item_id ?? null,
      title: o.goods?.title ?? o.goods?.goods_title ?? '', code,
      amount: o.pay_amount ?? o.total_amount, buyer: o.buyer_nick ?? '',
      paid_at: o.pay_time, text: code ? cardText(code) : null,
    });
  }
  return owed;
}

function printRow(r, i) {
  console.log(`${String(i + 1).padStart(2)}. ${r.order_no}  ${r.code ?? '认不出'}  ${r.title.slice(0, 24)}`);
}

/**
 * 读回订单真实状态。
 * ⚠️ 不能按 order_status=12 过滤去查：刚发完的单**已经离开**这个列表 ⇒ 会误判「读回失败」。
 * 必须不传状态、跨页找；找不到才返回 null。
 */
async function readBack(orderNo) {
  for (let i = 0; i < 6; i++) {
    for (let page = 1; page <= 10; page++) {
      const r = await listOrders({ page_no: page, page_size: 50 });
      const o = (r.list ?? []).find(x => String(x.order_no) === String(orderNo));
      if (o) return { order_status: Number(o.order_status), consign_time: Number(o.consign_time ?? 0),
        consign_type: Number(o.consign_type ?? 0) };
      if ((r.list ?? []).length < 50) break;
    }
    await new Promise(res => setTimeout(res, 1500));
  }
  return null;
}

(async () => {
  const owed = await collect();
  console.log(`\n待发货且无卡密：${owed.length} 单（最近 ${DAYS} 天）`);
  owed.forEach(printRow);
  const sendable = owed.filter(r => r.code && r.text);
  const missing = owed.filter(r => !r.code || !r.text);
  if (missing.length) console.log(`\n⚠️ 缺编号或缺卡密，不可发：${missing.map(r => r.order_no).join(', ')}`);

  if (flag('copy')) {
    for (const r of sendable) {
      console.log(`\n──── ${r.order_no} · ${r.code} ────\n${r.text}`);
    }
    return;
  }
  if (!SEND) {
    fs.writeFileSync('out/resend-owed-dry.json', JSON.stringify({ at: new Date().toISOString(),
      mode: 'dry', sendable: sendable.map(r => ({ order_no: r.order_no, code: r.code })), missing }, null, 2));
    console.log(`\n只读完成，未调用 dummy/send。灰度：--send --order <订单号>；全量：--send --all --yes`);
    return;
  }
  if (!sendable.length) { console.log('没有可发的订单'); return; }
  if (SINGLE && ALL) throw new Error('--order 与 --all 不能同时使用');
  if (ALL && !CONFIRMED) throw new Error('--all 是批量对外动作，必须同时带 --yes');
  const targets = SINGLE ? sendable.filter(r => r.order_no === SINGLE) : sendable;
  if (SINGLE && !targets.length) throw new Error(`${SINGLE} 不在可发清单里（状态不是 12 或缺卡密）`);

  const report = { mode: 'send', started_at: new Date().toISOString(), rows: [], halted: false };
  for (const r of targets) {
    const row = { order_no: r.order_no, code: r.code };
    try {
      // 发货前再读一次：状态已变的单（买家自己确认/退款）绝不能发
      const before = await readBack(r.order_no);
      if (!before || before.order_status !== PENDING || before.consign_time !== 0) {
        throw new Error(`发前状态已变（status=${before?.order_status}），跳过`);
      }
      await dummySend({ order_no: r.order_no, send_way: 1 }); // 1 = 虚拟发货
      const after = await readBack(r.order_no);
      row.after = after;
      const ok = after && after.order_status !== PENDING && after.consign_time > 0;
      row.status = ok ? 'verified' : 'unverified';
      if (!ok) { report.halted = true; report.stop_reason = 'readback_failed'; }
    } catch (error) {
      row.status = 'failed'; row.error = error.message;
      report.halted = true; report.stop_reason = 'send_failed';
    }
    report.rows.push(row);
    console.log(`${r.order_no} → ${row.status}${row.error ? ' · ' + row.error : ''}`);
    if (report.halted) break;
    if (targets.indexOf(r) < targets.length - 1) await new Promise(res => setTimeout(res, INTERVAL));
  }
  report.finished_at = new Date().toISOString();
  fs.writeFileSync(`out/resend-owed-send-${Date.now()}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ processed: report.rows.length, halted: report.halted, stop_reason: report.stop_reason }));
  if (report.halted) process.exitCode = 1;
})();
