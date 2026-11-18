/**
 * 只读盘点：闲管家「进销存」侧的卡密库现状。
 * 用法：GOOFISH_LIVE=true npx tsx scripts/_kami-inspect.ts
 *
 * 目的：查清「卡密分类 / 卡种 / 发卡组合」到底建过什么，以及
 *       发卡组合里有没有能指向商品的字段（用于决定能否 API 绑定商品）。
 */
import { listKamiCategories, listKamiKinds, listKamiGroups } from '../packages/goofish-adapter/src/api';

const j = (x: any) => JSON.stringify(x, null, 2);

try {
  console.log('════ 卡密分类 ════');
  const cats = await listKamiCategories();
  console.log(`共 ${cats.length} 个`);
  console.log(j(cats.slice(0, 20)));
} catch (e: any) {
  console.log('❌ 卡密分类读取失败：', String(e?.message ?? e).slice(0, 200));
}

try {
  console.log('\n════ 卡种 ════');
  const kinds = await listKamiKinds();
  console.log(`共 ${kinds.length} 个`);
  console.log(j(kinds.slice(0, 30)));
} catch (e: any) {
  console.log('❌ 卡种读取失败：', String(e?.message ?? e).slice(0, 200));
}

try {
  console.log('\n════ 发卡组合 ════');
  const groups = await listKamiGroups();
  console.log(`共 ${groups.length} 个`);
  console.log(j(groups.slice(0, 30)));
} catch (e: any) {
  console.log('❌ 发卡组合读取失败：', String(e?.message ?? e).slice(0, 200));
}
