/**
 * 探测 `kami/kind/edit` 还有没有别的可写字段（可能藏着"启用自动发货"开关）。
 *
 * 手法同前：传类型错误的值，Go 的 json 解码报错会带出字段名。
 * 用一个**已绑定**的真实卡种，每次都用 getKamiKind 读回完整字段再改，
 * 保证不会把其它字段清空。
 */
import { getKamiKind, editKamiKind } from '../packages/goofish-adapter/src/api';

const KIND_ID = Number(process.argv[2] ?? 1806021265558917);

const CANDIDATES: Array<[string, unknown]> = [
  ['status', 'not-a-number'],
  ['enable', 'not-a-number'],
  ['is_enable', 'not-a-number'],
  ['auto', 'not-a-number'],
  ['is_auto', 'not-a-number'],
  ['deliver_type', 'not-a-number'],
  ['deliver_way', 'not-a-number'],
  ['send_type', 'not-a-number'],
  ['consign_type', 'not-a-number'],
  ['priority_sale', 'not-a-number'],
  ['sale_type', 'not-a-number'],
  ['stock_mode', 'not-a-number'],
  ['bind_type', 'not-a-number'],
  ['trade_type', 'not-a-number'],
  ['content_type', 'not-a-number'],
];

async function base() {
  const k = (await getKamiKind(KIND_ID)) as never as Record<string, unknown>;
  return {
    kind_id: KIND_ID,
    kind_name: k.kind_name ?? '',
    kind_alias: k.kind_alias ?? '',
    kind_category: Number(k.kind_category ?? 0),
    kind_type: Number(k.kind_type ?? 1),
    card_type: Number(k.card_type ?? 1),
    pwd_type: Number(k.pwd_type ?? 1),
    card_prefix: k.card_prefix ?? '',
    pwd_prefix: k.pwd_prefix ?? '',
    separator: Number(k.separator ?? 0),
    stock_warning: Number(k.stock_warning ?? 20),
    sort: Number(k.sort ?? 1),
    cost: Number(k.cost ?? 0),
    app_id: Number(k.app_id ?? 0),
    goods_no: String(k.goods_no ?? ''),
    goods_name: String(k.goods_name ?? ''),
  };
}

async function main() {
  console.log(`探测卡种 ${KIND_ID} 的可写字段\n`);
  const hit: string[] = [];
  for (const [field, badValue] of CANDIDATES) {
    try {
      await editKamiKind({ ...(await base()), [field]: badValue } as never);
      console.log(`· ${field.padEnd(16)} 静默忽略（字段不存在）`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/type mismatch|unmarshal/i.test(msg)) {
        console.log(`· ${field.padEnd(16)} ✅ 字段存在 → ${msg.replace(/^\[[^\]]+\]\s*/, '').slice(0, 90)}`);
        hit.push(field);
      } else {
        console.log(`· ${field.padEnd(16)} ? ${msg.replace(/^\[[^\]]+\]\s*/, '').slice(0, 90)}`);
      }
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  console.log(`\n存在且可写的：${hit.length ? hit.join(', ') : '（无）'}`);
  const k = (await getKamiKind(KIND_ID)) as never as Record<string, unknown>;
  console.log(`读回核对：goods_no=${k.goods_no} app_id=${k.app_id} priority_sale=${k.priority_sale}`);
}

void main().catch((e) => console.error('💥', e instanceof Error ? e.message : e));
