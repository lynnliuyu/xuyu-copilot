import { listOrders, getOrderKamiList } from '../packages/goofish-adapter/src/api.ts';
const want = new Set(process.argv.slice(2));
const found = new Map<string, any>();
for (let page = 1; page <= 30; page++) {
  const r: any = await listOrders({ page_no: page, page_size: 50 });
  const list = r?.data?.list || r?.list || r?.data?.orders || [];
  if (!list.length) break;
  for (const o of list) {
    const no = String(o.order_no);
    if (want.has(no)) found.set(no, o);
  }
  if (found.size === want.size) break;
  if (list.length < 50) break;
}
for (const no of want) {
  const o = found.get(no);
  if (!o) {
    console.log(JSON.stringify({ order_no: no, found: false }));
    continue;
  }
  let kami: any = null;
  try {
    kami = await getOrderKamiList({ order_no: no });
  } catch (e: any) {
    kami = { error: String(e?.message || e) };
  }
  const kamiList = kami?.data?.list || kami?.list || kami?.data || [];
  console.log(
    JSON.stringify({
      order_no: no,
      found: true,
      order_status: o.order_status,
      consign_time: o.consign_time,
      consign_type: o.consign_type,
      refund_status: o.refund_status,
      pay_time: o.pay_time,
      pay_amount: o.pay_amount ?? o.total_amount,
      title: o.goods?.[0]?.title || o.title || '',
      product_id: o.goods?.[0]?.product_id || o.product_id,
      kami_count: Array.isArray(kamiList) ? kamiList.length : -1,
      kami_snip: JSON.stringify(kami).slice(0, 240),
    }),
  );
}
