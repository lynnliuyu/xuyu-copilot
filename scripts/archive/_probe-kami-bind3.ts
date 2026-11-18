/**
 * 隔离实验 2：证明 `kami/kind/edit` 真的能把卡种绑到商品上。
 *
 * 上一轮已确认 schema 接受 `goods_no`(string) + `app_id`(number) + `goods_name`(string)。
 * 这一轮要回答三个问题：
 *   ① `goods_no` 能写进去吗（写进去后读回来是否还在）
 *   ② 服务端校不校验这个商品存在（填错会不会被拒）
 *   ③ `app_id` 该填 0 还是某个真实应用 ID
 *
 * 全程在临时卡种上做，结束即删。
 */
import {
  createKamiKind,
  editKamiKind,
  deleteKamiKind,
  getKamiKind,
  listKamiKinds,
} from '../packages/goofish-adapter/src/api';

const NAME = 'ZZ-PROBE-可删-绑商品';
const TEST_GOODS = 'BD-GFX-124840';

async function mkKind() {
  const existing = await listKamiKinds();
  for (const k of existing) {
    if (k.kind_name === NAME && k.kind_id) await deleteKamiKind({ kind_id: k.kind_id });
  }
  const c = await createKamiKind({
    kind_name: NAME,
    kind_type: 1,
    card_type: 1,
    pwd_type: 1,
    card_prefix: '链接：',
    pwd_prefix: '提取码：',
    separator: 0,
    stock_warning: 20,
    sort: 99,
  } as never);
  return Number(c.kind_id);
}

function safeBase(kindId: number) {
  return {
    kind_id: kindId,
    kind_name: NAME,
    kind_alias: '',
    kind_category: 0,
    kind_type: 1,
    card_type: 1,
    pwd_type: 1,
    card_prefix: '链接：',
    pwd_prefix: '提取码：',
    separator: 0,
    stock_warning: 20,
    sort: 99,
    cost: 0,
  };
}

async function readBack(kindId: number) {
  const k = (await getKamiKind(kindId)) as never as Record<string, unknown>;
  return {
    app_id: k.app_id,
    app_name: k.app_name,
    goods_no: k.goods_no,
    goods_name: k.goods_name,
    goods_price: k.goods_price,
    goods_stock: k.goods_stock,
  };
}

async function tryEdit(kindId: number, patch: Record<string, unknown>, label: string) {
  try {
    await editKamiKind({ ...safeBase(kindId), ...patch } as never);
    const after = await readBack(kindId);
    console.log(`   · ${label}`);
    console.log(`       调用成功 → 读回 ${JSON.stringify(after)}`);
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`   · ${label}`);
    console.log(`       ❌ ${msg.replace(/^\[[^\]]+\]\s*/, '').slice(0, 200)}`);
    return false;
  }
}

async function main() {
  const kindId = await mkKind();
  console.log(`测试卡种 kind_id=${kindId}\n初始：${JSON.stringify(await readBack(kindId))}\n`);

  try {
    console.log('① 只填 goods_no、app_id=0');
    await tryEdit(kindId, { goods_no: TEST_GOODS, app_id: 0 }, 'goods_no=BD-GFX-124840');

    console.log('\n② 填一个不存在的编号，看有没有存在性校验');
    await tryEdit(kindId, { goods_no: 'NOT-A-REAL-GOODS-999', app_id: 0 }, 'goods_no=假编号');
    await readBack(kindId).then((r) => console.log(`       读回：${JSON.stringify(r)}`));

    console.log('\n③ 恢复成真实编号，并补 goods_name');
    await tryEdit(
      kindId,
      { goods_no: TEST_GOODS, goods_name: '测试商品名（会被读回吗）', app_id: 0 },
      'goods_no + goods_name',
    );

    console.log('\n④ 换一个 app_id（本应用 AppKey）');
    const appKey = Number(process.env.GOOFISH_ERP_APP_KEY ?? process.env.GOOFISH_APP_KEY ?? 0);
    if (appKey) {
      await tryEdit(kindId, { goods_no: TEST_GOODS, app_id: appKey }, `app_id=${appKey}`);
    } else {
      console.log('   · 跳过（读不到 AppKey）');
    }

    console.log('\n⑤ 最终状态');
    console.log(JSON.stringify(await readBack(kindId), null, 1));
  } finally {
    try {
      await deleteKamiKind({ kind_id: kindId });
      console.log('\n✅ 测试卡种已删除');
    } catch (e: unknown) {
      console.log(`\n❌ 删除失败，请手动删 kind_id=${kindId}`);
      console.log(String(e));
    }
  }
}

void main();
