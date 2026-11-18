/**
 * 判定 `goods_no` 该填什么：`outer_id`（BD-GFX-xxxx）还是 `product_id`（雪花数字）。
 *
 * 判据：`kami/kind/info` 会返回 `goods_name` / `goods_price` / `goods_stock`。
 *   · 如果服务端**认得**这个编号 → 这三个字段会被从商品库回填
 *   · 如果只是存字符串 → 三个字段一直是空 / 0.00 / 0
 *
 * 所以依次填入三种编号，看哪个能让 `goods_name` 出现。
 * 结束后**恢复成 outer_id**（当前生产用的那个）。
 */
import { getKamiKind, listKamiKinds, bindKamiKindToGoods } from '../packages/goofish-adapter/src/api';
import { listProducts } from '../packages/goofish-adapter/src/api';

const CODE = 'BD-GFX-124840';

async function probe(kindId: number, label: string, value: string) {
  await bindKamiKindToGoods({ kind_id: kindId, goods_no: value, goods_name: '' });
  const k = (await getKamiKind(kindId)) as never as Record<string, unknown>;
  const filled = Boolean(String(k.goods_name ?? '').trim());
  console.log(`· ${label}  goods_no="${k.goods_no}"`);
  console.log(
    `   goods_name=${JSON.stringify(k.goods_name)} price=${JSON.stringify(k.goods_price)} stock=${k.goods_stock}  ${filled ? '✅ 服务端认出来了' : '（未回填）'}`,
  );
  return filled;
}

async function main() {
  const kinds = await listKamiKinds();
  const hit = kinds.find((k) => String(k.goods_no ?? '') === CODE);
  if (!hit?.kind_id) {
    console.log(`❌ 没找到绑定 ${CODE} 的卡种`);
    return;
  }
  const kindId = hit.kind_id;
  console.log(`卡种 ${kindId}\n`);

  // 查出这个 code 对应的 product_id / item_id
  let productId = '';
  let itemId = '';
  for (let page = 1; page <= 10; page++) {
    const r = await listProducts({ page_no: page, page_size: 50 } as never);
    const list = r.list ?? [];
    const p = list.find((x) => String(x.outer_id ?? '') === CODE);
    if (p) {
      productId = String(p.product_id);
      itemId = String(p.item_id ?? '');
      console.log(`商品：product_id=${productId} item_id=${itemId} title=${String(p.title).slice(0, 30)}\n`);
      break;
    }
    if (list.length < 50) break;
  }
  if (!productId) {
    console.log('❌ 线上商品列表里找不到这个 outer_id');
    return;
  }

  console.log('① 当前（outer_id）');
  await probe(kindId, 'outer_id', CODE);

  console.log('\n② 改成 product_id');
  await probe(kindId, 'product_id', productId);

  if (itemId && itemId !== '0') {
    console.log('\n③ 改成 item_id（闲鱼商品 ID）');
    await probe(kindId, 'item_id', itemId);
  }

  console.log('\n④ 恢复成 outer_id');
  await bindKamiKindToGoods({ kind_id: kindId, goods_no: CODE, goods_name: '' });
  const back = (await getKamiKind(kindId)) as never as Record<string, unknown>;
  console.log(`   已恢复 goods_no=${back.goods_no}`);
}

void main().catch((e) => console.error('💥', e instanceof Error ? e.message : e));
