/** 探测 kami/kind/delete 的 kind_id 形态（数组？元素类型？）。 */
import { getClient } from '../packages/goofish-adapter/src/config';

const KIND = '1800375379168581';
const c = getClient();

const variants: Array<[string, any]> = [
  ['kind_id=[string]', { kind_id: [KIND] }],
  ['kind_id=[number]', { kind_id: [Number(KIND)] }],
  ['kind_ids=[string]', { kind_ids: [KIND] }],
];

for (const [label, body] of variants) {
  try {
    const r: any = await c.call('/api/open/kami/kind/delete', body);
    console.log(`✅ ${label} → ${JSON.stringify(r)}`);
    break;
  } catch (e: any) {
    console.log(`❌ ${label} → ${JSON.stringify(e?.raw ?? e?.message)}`);
  }
}
