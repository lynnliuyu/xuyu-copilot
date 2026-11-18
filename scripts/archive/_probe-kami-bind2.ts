/**
 * 隔离实验：在**临时卡种**上验证 `kami/kind/edit` 到底能不能写商品关联字段。
 *
 * 为什么不在现成卡种上试：万一字段真的可写，一个类型正确的值就会**真改线上配置**，
 * 可能让某个在售商品的卡密发货指向错误商品。所以：
 *   1. `kind/create` 建一个 "ZZ-PROBE-可删" 测试卡种
 *   2. 在它身上把所有候选字段试一遍
 *   3. `kind/delete` 删掉（无库存，删了不影响任何商品）
 *
 * 判据：Go json 解码在业务校验之前，所以传**类型错误**的值时，
 *   报 `cannot unmarshal ... field Xxx.yyy`
 *   ⇒ 字段真实存在于接口 schema；
 *   静默通过（返回其它业务错误或成功）
 *   ⇒ 字段不存在，被 Go 忽略。
 */
import {
  createKamiKind,
  editKamiKind,
  deleteKamiKind,
  getKamiKind,
  listKamiKinds,
} from '../packages/goofish-adapter/src/api';

const NAME = 'ZZ-PROBE-可删-绑定测试';

interface Case {
  label: string;
  patch: Record<string, unknown>;
}

const CASES: Case[] = [
  { label: 'goods_no (string 探测)', patch: { goods_no: 12345 } },
  { label: 'app_id (number 探测)', patch: { app_id: 'not-a-number' } },
  { label: 'erp_id (number 探测)', patch: { erp_id: 'not-a-number' } },
  { label: 'product_id (number 探测)', patch: { product_id: 'not-a-number' } },
  { label: 'priority_sale 能否改成 2', patch: { priority_sale: 2 } },
  { label: 'goods_name (string 探测)', patch: { goods_name: 999 } },
  { label: 'app_name (string 探测)', patch: { app_name: 999 } },
];

async function main() {
  console.log('① 清理同名残留测试卡种');
  const existing = await listKamiKinds();
  for (const k of existing) {
    if (k.kind_name === NAME && k.kind_id) {
      console.log(`   删除残留 kind_id=${k.kind_id}`);
      await deleteKamiKind({ kind_id: k.kind_id });
    }
  }

  console.log('\n② 创建测试卡种');
  const created = await createKamiKind({
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
  const kindId = Number(created.kind_id);
  console.log(`   ✅ kind_id=${kindId}`);

  try {
    const base = await getKamiKind(kindId);
    console.log('\n③ 新建卡种的初始关联字段');
    console.log(
      `   app_id=${(base as never as Record<string, unknown>).app_id} goods_no=${
        (base as never as Record<string, unknown>).goods_no
      } erp_id=${(base as never as Record<string, unknown>).erp_id}`,
    );

    console.log('\n④ 逐字段探测 kind/edit');
    const raw = base as never as Record<string, unknown>;
    const safeBase = {
      kind_id: kindId,
      kind_name: raw.kind_name,
      kind_alias: raw.kind_alias ?? '',
      kind_category: raw.kind_category ?? 0,
      kind_type: raw.kind_type ?? 1,
      card_type: raw.card_type ?? 1,
      pwd_type: raw.pwd_type ?? 1,
      card_prefix: raw.card_prefix ?? '',
      pwd_prefix: raw.pwd_prefix ?? '',
      separator: raw.separator ?? 0,
      stock_warning: raw.stock_warning ?? 20,
      sort: raw.sort ?? 99,
      cost: Number(raw.cost ?? 0),
    };
    for (const c of CASES) {
      try {
        const r = await editKamiKind({ ...safeBase, ...c.patch } as never);
        console.log(`   · ${c.label}`);
        console.log(`       静默通过（字段不存在被忽略）→ ${JSON.stringify(r).slice(0, 80)}`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const unmarshal = msg.match(/cannot unmarshal .*?field (\S+)/i);
        console.log(`   · ${c.label}`);
        if (unmarshal) console.log(`       ✅ 字段存在 → ${unmarshal[1]}`);
        else console.log(`       ?  ${msg.replace(/^\[[^\]]+\]\s*/, '').slice(0, 130)}`);
      }
      await new Promise((r) => setTimeout(r, 130));
    }

    console.log('\n⑤ 探测后重新读取，看有没有字段被真的写进去');
    const after = (await getKamiKind(kindId)) as never as Record<string, unknown>;
    for (const k of ['goods_no', 'goods_name', 'app_id', 'app_name', 'erp_id', 'priority_sale']) {
      console.log(`   ${k.padEnd(14)} = ${JSON.stringify(after[k])}`);
    }
  } finally {
    console.log('\n⑥ 删除测试卡种');
    try {
      await deleteKamiKind({ kind_id: kindId });
      console.log('   ✅ 已删除');
    } catch (e: unknown) {
      console.log(`   ❌ 删除失败，请手动删 kind_id=${kindId}：${e instanceof Error ? e.message : e}`);
    }
  }
}

void main();
