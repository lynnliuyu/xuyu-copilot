/**
 * Batch driver for product-side shipping configuration (`/v1/kami/consign/*`).
 *
 * Same guards as the single-product path in `xgj-web-client.mjs`, plus:
 *   - `plan()` is read-only: no `kamiConsignSave`, decided by injected command allowlist.
 *   - `apply()` refuses targets that were not `ready` in the same batch's plan
 *     (`sameBatch`), so a repeated `--plan` after a partial run cannot re-send
 *     writes for products we already configured.
 *   - Serial writes, >=3.5s apart (handled by the client's per-path throttle).
 *   - Any write failure stops the run and still reads back the submitted product.
 *   - Never retries a write, including timeouts with unknown outcome.
 */
import { makeConsignPayload } from './consign-config.mjs';

export class BatchError extends Error {}

const positiveInt = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const sameCodes = (targets, previous) => Array.isArray(previous) && previous.length === targets.length
  && targets.every((row, i) => Number(previous[i]?.product_id) === Number(row.product_id)
    && previous[i]?.code === row.code);

/** Mirrors the guards inside `saveSingle`, so a corrupted plan file cannot reach the network. */
const isValidPayload = p => Array.isArray(p.product_id) && p.product_id.length === 1
  && Array.isArray(p.product_list) && p.product_list.length === 1
  && Number(p.kind_way) === 4 && Number(p.status) === 1 && Number(p.send_type) === 1
  && Number(p.ex_url_status) === 0 && Number(p.adjust_price?.status) !== 1
  && typeof p.goods_no === 'string' && !!p.goods_no;

/** Idempotent detection of an already-correct configuration; never used to decide a write. */
export function isConfigured(detail, { appId, code }) {
  const c = detail?.consign;
  return Number(c?.status) === 1 && Number(c?.kind_way) === 4
    && Number(c?.app_id) === Number(appId) && String(c?.goods_no) === code;
}

async function findTemplate(client, targets, explicitId) {
  if (explicitId !== undefined) {
    if (!positiveInt(explicitId)) throw new BatchError('参考商品 ID 必须是正整数');
    const template = await client.info(Number(explicitId));
    if (Number(template?.consign?.kind_way) !== 4) throw new BatchError('参考商品必须是直接货源模式');
    return template;
  }
  // Prefer a product in this batch that is already correctly configured.
  for (const target of targets) {
    const detail = await client.info(target.product_id);
    if (isConfigured(detail, { appId: target.app_id, code: target.code })) return detail;
  }
  throw new BatchError('未找到已启用的直接货源参考配置；请显式指定 template_product_id');
}

async function exactSource(client, appId, code) {
  const list = (await client.source(appId, code))?.list;
  const matches = Array.isArray(list) ? list.filter(item => item.goods_no === code) : [];
  if (matches.length !== 1) throw new BatchError(`货源查询未找到唯一对应商品：${code}`);
  return matches[0];
}

/**
 * Read-only pass over every target.
 * Returns `rows` where `ready` rows carry the exact payload that `apply` will submit.
 */
export async function plan(client, targets, { appId, templateProductId } = {}) {
  if (!Array.isArray(targets) || !targets.length) throw new BatchError('计划为空');
  const ids = targets.map(t => Number(t.product_id));
  if (new Set(ids).size !== ids.length) throw new BatchError('多个资源映射到同一个商品，停止');
  for (const t of targets) {
    if (!positiveInt(t.product_id) || !positiveInt(t.appId ?? appId)) {
      throw new BatchError(`${t.code}：商品 ID 或货源应用 ID 不合法`);
    }
  }
  const appIdOf = t => Number(t.appId ?? appId);
  const template = await findTemplate(client, targets, templateProductId);
  const templateAppId = Number(template.consign.app_id);

  const rows = [];
  for (const target of targets) {
    const row = { code: target.code, product_id: Number(target.product_id), status: 'blocked' };
    try {
      // Per-item source app always matches the verified template.
      const itemAppId = appIdOf(target);
      if (itemAppId !== templateAppId) throw new BatchError('参考配置的货源应用与目标不一致');
      const before = await client.info(target.product_id);
      if (Number(before?.product?.product_id) !== Number(target.product_id)) {
        throw new BatchError('响应商品 ID 与查询目标不一致');
      }
      if (isConfigured(before, { appId: itemAppId, code: target.code })) {
        row.status = 'already-configured';
        rows.push(row);
        continue;
      }
      if (Number(before?.consign?.status) === 1) {
        row.error = '已有其他启用配置，保留原配置';
        rows.push(row);
        continue;
      }
      const source = await exactSource(client, itemAppId, target.code);
      const payload = makeConsignPayload({ code: target.code, product_id: Number(target.product_id), kind_id: 0 },
        before, null, template, itemAppId, source);
      if (!payload) {
        row.status = 'already-configured';
        rows.push(row);
        continue;
      }
      const result = await client.saveSingle(payload, { before });
      if (result.dry_run !== true) throw new BatchError('预演阶段出现了非预演结果，停止');
      row.status = 'ready';
      row.source = { title: source.title, purchase_price: source.purchase_price, stock: source.stock };
      row.payload = payload;
      // Live snapshot the apply pass must still match.
      row.before = before;
    } catch (error) {
      row.status = 'blocked';
      row.error = error.message;
      // Unknown outcome or transport failure: stop the read-only pass too.
      if (/网络|超时|HTTP|解密|运行库/.test(error.message)) { rows.push(row); break; }
    }
    rows.push(row);
  }
  return { mode: 'plan', template_source: { product_id: Number(template.product.product_id), app_id: templateAppId },
    rows };
}

/**
 * Serial apply. `sameBatch` must be this batch's plan rows (or an array of their codes).
 * Re-reads the live config and re-checks the payload before every save.
 */
export async function apply(client, rows, { sameBatch, halt } = {}) {
  const ready = rows.filter(r => r.status === 'ready');
  if (!ready.length) throw new BatchError('计划里没有需要保存的商品');
  // Require the exact same batch order; a different set means the plan is stale.
  if (!sameCodes(rows, sameBatch)) throw new BatchError('缺少同一批次的预演记录，停止保存');
  for (const row of ready) {
    if (!row.before || !row.payload || !isValidPayload(row.payload)) {
      throw new BatchError(`${row.code}：没有可用的预演快照，停止保存`);
    }
  }
  const results = [];
  let halted = false;
  let stopReason = '';
  for (const row of ready) {
    if (halted || halt?.()) { stopReason = 'stopped_before_start'; break; }
    const out = { code: row.code, product_id: row.product_id, status: 'blocked' };
    try {
      const saved = await client.saveSingle(row.payload, { before: row.before, apply: true });
      out.status = saved.status;
      if (saved.status === 'already-configured') out.note = '预演后已存在相同配置，幂等跳过';
    } catch (error) {
      out.error = error.message;
      // No retries; read back whatever landed so the operator knows the live state.
      try {
        const after = await client.info(row.product_id);
        out.after_status = { status: after?.consign?.status, kind_way: after?.consign?.kind_way,
          goods_no: after?.consign?.goods_no };
      } catch (readback) { out.readback_error = readback.message; }
      halted = true;
      stopReason = 'write_failed';
    }
    results.push(out);
    if (halted) break;
  }
  return { mode: 'apply', rows: results, halted, stop_reason: stopReason,
    processed: results.length, remaining: Math.max(0, ready.length - results.length) };
}
