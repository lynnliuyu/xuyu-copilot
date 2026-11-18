/** Product-side shipping configuration. Payload mirrors the official v3.71.1 form. */
export function buildConsignPlan(listings, kinds, cards, resources, { codes } = {}) {
  const byCode = new Map();
  for (const r of Object.values(resources)) {
    if (!r.draft_code) continue;
    if (byCode.has(r.draft_code)) throw new Error(`重复资源编号：${r.draft_code}`);
    byCode.set(r.draft_code, r);
  }
  const targets = [], skipped = [];
  for (const [code, row] of Object.entries(listings)) {
    if (codes ? !codes.includes(code) : row.state !== 'on_sale') continue;
    const resource = byCode.get(code);
    const links = ['baidu', 'quark'].flatMap(side => {
      const value = resource?.[side];
      if (!value?.share_url) return [];
      const url = new URL(value.share_url);
      const host = side === 'baidu' ? 'pan.baidu.com' : 'pan.quark.cn';
      if (url.protocol !== 'https:' || url.hostname !== host || !url.pathname.startsWith('/s/')) {
        throw new Error(`${code} 的${side}分享地址不合法`);
      }
      return [{ side, url: url.href, pwd: String(value.pwd || '') }];
    });
    const reason = !Number.isSafeInteger(row.product_id) || row.product_id <= 0 ? '缺少商品 ID'
      : !kinds[code]?.kind_id ? '未建卡种'
      : !links.length ? '资源注册表没有分享链接'
      : !cards[code]?.some(c => !c.used && links.every(l => String(c.card_pwd || '').includes(l.url))) ? '可用卡密与资源分享链接不一致'
      : '';
    if (reason) { skipped.push({ code, reason }); continue; }
    targets.push({ code, product_id: row.product_id, kind_id: kinds[code].kind_id,
      title: row.title || resource.display_name || code, links });
  }
  const ids = targets.map(t => t.product_id);
  if (new Set(ids).size !== ids.length) throw new Error('多个资源映射到同一个商品，停止配置');
  return { targets, skipped };
}

/**
 * Never guess defaults: copy a live, working configuration, preserving per-item settings.
 * The template must be a verified response (`consign` + `product`), never one of our own rows.
 */
export function assertConsignTemplate(template) {
  if (!template?.consign || !template.product || Number(template.consign.status) !== 1
      || ![2, 4].includes(Number(template.consign.kind_way)) || Number(template.consign.send_type) !== 1) {
    throw new Error('参考发货配置必须是线上已启用且读回成功的配置');
  }
  return template;
}

/** Never guess defaults: copy a live, working configuration, preserving per-item settings. */
export function makeConsignPayload(target, detail, kind, rawTemplate, appId, source) {
  const template = assertConsignTemplate(rawTemplate);
  const current = detail.consign, product = detail.product;
  const base = template.consign;
  if (!current || !product || !base) throw new Error('缺少商品发货配置返回字段');
  if (Number(base.kind_way) === 2 && (String(kind.goods_no) !== target.code || Number(kind.app_id) !== appId
      || Number(kind.priority_sale) !== 2 || !kind.goods_name)) throw new Error('卡种货源关联未通过读回验证');
  if (Number(product.product_id) !== target.product_id || !(Number(product.item_id) > 0)
      || !(Number(product.authorize_id) > 0)) throw new Error('线上商品或店铺 ID 无法核对');
  if (Number(current.status) === 1) {
    if (Number(current.kind_way) === 2 && Number(current.kind_id) === target.kind_id) return null;
    if (Number(current.kind_way) === 4 && Number(current.app_id) === appId
        && String(current.goods_no) === target.code) return null;
    throw new Error('商品已有其他启用中的发货配置，保留原配置');
  }
  if (![2, 4].includes(Number(base.kind_way)) || Number(base.status) !== 1 || Number(base.send_type) !== 1) {
    throw new Error('需要一份已经启用的卡种或货源发货配置作为模板');
  }
  const fields = ['send_type', 'send_dummy', 'send_limit_min', 'send_limit_max', 'postscript',
    'send_statement', 'ex_url_status', 'extra_config', 'send_rule', 'send_multiple', 'again_send', 'template_id'];
  const payload = {};
  for (const key of fields) {
    const value = current.consign_id ? current[key] : base[key];
    if (value === undefined) throw new Error(`官方返回缺少 ${key}，停止猜测参数`);
    payload[key] = value;
  }
  // URL exchange and custom message templates are separate workflows; don't silently copy them.
  if (Number(payload.ex_url_status) !== 0) {
    throw new Error('已有自助兑换，需要单独核对');
  }
  const adjust = current.consign_id ? detail.adjust_price : template.adjust_price;
  if (Number(adjust?.status) === 1) throw new Error('已有自动调价设置，停止覆盖');
  const body = { ...payload, consign_id: current.consign_id || 0, product_id: [target.product_id],
    product_sku: current.product_sku || 0, kind_way: 2, kind_id: target.kind_id, status: 1,
    product_list: [{ authorize_id: product.authorize_id, item_id: product.item_id, product_id: target.product_id }],
    ...(adjust ? { adjust_price: { ...adjust } } : {}) };
  if (Number(base.kind_way) === 4) {
    if (Number(base.app_id) !== appId || !Number.isSafeInteger(base.erp_id)
        || String(source?.goods_no) !== target.code || !source.title
        || !Number.isFinite(Number(source.purchase_price)) || Number(source.purchase_price) < 0
        || !(Number(source.stock) > 0)) throw new Error('货源商品编号、价格或库存未核对');
    Object.assign(body, { kind_way: 4, kind_id: 0, app_id: appId, erp_id: base.erp_id,
      goods_no: target.code, goods_name: source.title,
      goods_price: Math.round(Number(source.purchase_price) * 100), goods_stock: Number(source.stock) });
  }
  return body;
}
