/**
 * 诊断：拉取闲管家商品详情，打印「是否真上架」的硬指标。
 * 用法：GOOFISH_LIVE=true npx tsx scripts/_probe-quota.ts <product_id...>
 *
 * 判定（见项目铁律）：
 *   · item_id > 0           → 真上架
 *   · product_status=22     → 在售
 *   · product_status=21 且 item_id=0 → 卡草稿（账号级上限 / 数据缺陷）
 *   · product_status=36     → 已下架
 *   publish_shop.length > 1 → 换店未 --recreate 的残留（数据缺陷，可修）
 */
import { getProduct } from '../packages/goofish-adapter/src/api';

const ids = process.argv.slice(2).map(Number).filter(Boolean);
if (!ids.length) {
  console.error('用法：GOOFISH_LIVE=true npx tsx scripts/_probe-quota.ts <product_id...>');
  process.exit(1);
}

const LABEL: Record<number, string> = { 21: '草稿', 22: '在售', 36: '已下架' };

for (const pid of ids) {
  try {
    const d: any = await getProduct(pid);
    const shops: any[] = d.publish_shop ?? [];
    const st = Number(d.product_status);
    console.log(`\n=== product_id=${pid}  product_status=${st}(${LABEL[st] ?? '?'})  publish_shop 条数=${shops.length} ===`);
    console.log(`  title: ${d.title ?? shops[0]?.title ?? ''}`);
    for (const s of shops) {
      console.log(`  [${s.user_name}] item_id=${s.item_id ?? 0}  status=${s.status ?? '-'}`);
    }
  } catch (e: any) {
    console.log(`\n=== product_id=${pid}  ❌ ${e?.message ?? e}`);
  }
}
