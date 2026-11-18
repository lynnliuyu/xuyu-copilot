/**
 * 隔离实验 3：绑定时是否校验 goods_no 存在。
 * 只关心一件事：填错编号会不会被拒 —— 决定我们要不要先把编号核对一遍。
 */
import {
  createKamiKind,
  editKamiKind,
  deleteKamiKind,
  getKamiKind,
  listKamiKinds,
} from '../packages/goofish-adapter/src/api';

const NAME = 'ZZ-PROBE-可删-校验';
const APP_ID = Number(process.env.GOOFISH_ERP_APP_KEY ?? process.env.GOOFISH_APP_KEY ?? 0);

async function main() {
  const old = await listKamiKinds();
  for (const k of old) if (k.kind_name === NAME && k.kind_id) await deleteKamiKind({ kind_id: k.kind_id });

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
  const id = Number(c.kind_id);
  const base = {
    kind_id: id,
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
    app_id: APP_ID,
  };
  console.log(`测试卡种 ${id}，app_id=${APP_ID}\n`);

  const cases = [
    ['假编号 FAKE-NO-999', 'FAKE-NO-999'],
    ['真 outer_id BD-GFX-124840', 'BD-GFX-124840'],
    ['填 product_id 数字串', '1790593015023429'],
  ];
  try {
    for (const [label, no] of cases) {
      try {
        await editKamiKind({ ...base, goods_no: no } as never);
        const k = (await getKamiKind(id)) as never as Record<string, unknown>;
        console.log(`· ${label}`);
        console.log(`   调用成功，读回 goods_no="${k.goods_no}" goods_name="${k.goods_name}"`);
      } catch (e: unknown) {
        console.log(`· ${label}`);
        console.log(`   ❌ ${(e instanceof Error ? e.message : String(e)).slice(0, 180)}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  } finally {
    await deleteKamiKind({ kind_id: id }).then(
      () => console.log('\n✅ 已删除'),
      (e) => console.log(`\n❌ 删除失败 kind_id=${id}: ${e}`),
    );
  }
}
void main();
