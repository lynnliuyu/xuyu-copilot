/** 临时工具：拉取闲管家商品详情，核对线下发的图片。用法：GOOFISH_LIVE=true npx tsx scripts/_check-listing.ts <product_id...> */
import { getProduct } from '../packages/goofish-adapter/src/api';

const ids = process.argv.slice(2).map(Number).filter(Boolean);
if (!ids.length) {
  console.error('用法：npx tsx scripts/_check-listing.ts <product_id...>');
  process.exit(1);
}
for (const pid of ids) {
  try {
    const d: any = await getProduct(pid);
    const shops: any[] = d.publish_shop ?? [];
    console.log(`\n=== product_id=${pid}  product_status=${d.product_status}  店铺数=${shops.length} ===`);
    console.log(`  title: ${d.title ?? shops[0]?.title ?? ''}`);
    for (const s of shops) console.log(`  [${s.user_name}] images = ${JSON.stringify(s.images ?? [])}`);
  } catch (e: any) {
    console.log(`\n=== product_id=${pid}  ❌ ${e?.message ?? e}`);
  }
}
