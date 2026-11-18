/**
 * 只读探测：卡种/发卡组合里那几个"商品关联"字段，到底能不能写。
 *
 * 背景：`kami/kind/list` 实际返回里有 `app_id / app_name / erp_id / goods_no / goods_name`
 * 这些字段，但我们的 TS 类型定义里没有（类型是从旧文档抄的，不全）。
 * 如果 `kami/kind/edit` 接受它们，那"卡密绑商品"就能全自动，不用后台点。
 *
 * 手法：给字段传**类型错误**的值，利用 Go 的 json 解码报错反推 schema。
 *   `json: cannot unmarshal number into Go struct field Xxx.goods_no of type string`
 *   ↑ 报出字段名 = 字段真实存在
 *   故意忽略（走到业务校验）= 字段不存在
 *
 * 安全保障：
 *   - kind_id / group_id 全部用 9999999990xx 这种绝不会存在的值
 *   - 即便真被接受，也不会改动任何现存卡种
 *   - 只发 8 个请求，远低于 QPS 限制
 */
import { getClient } from '../packages/goofish-adapter/src/config';

const DEAD = 9999999990000;

interface Probe {
  label: string;
  path: string;
  body: Record<string, unknown>;
}

const probes: Probe[] = [
  // ── 卡种：能不能直接绑商品 ──────────────────────────────
  {
    label: 'kind/edit · goods_no 是 string？',
    path: '/api/open/kami/kind/edit',
    body: { kind_id: DEAD + 1, kind_name: 'probe', goods_no: 12345 },
  },
  {
    label: 'kind/edit · app_id 是 number？',
    path: '/api/open/kami/kind/edit',
    body: { kind_id: DEAD + 2, kind_name: 'probe', app_id: 'not-a-number' },
  },
  {
    label: 'kind/edit · erp_id 是 number？',
    path: '/api/open/kami/kind/edit',
    body: { kind_id: DEAD + 3, kind_name: 'probe', erp_id: 'not-a-number' },
  },
  {
    label: 'kind/edit · product_id 存在？',
    path: '/api/open/kami/kind/edit',
    body: { kind_id: DEAD + 4, kind_name: 'probe', product_id: 'not-a-number' },
  },
  {
    label: 'kind/edit · group_id 存在？',
    path: '/api/open/kami/kind/edit',
    body: { kind_id: DEAD + 5, kind_name: 'probe', group_id: 'not-a-number' },
  },
  {
    label: 'kind/edit · priority_sale 是 number？',
    path: '/api/open/kami/kind/edit',
    body: { kind_id: DEAD + 6, kind_name: 'probe', priority_sale: 'not-a-number' },
  },

  // ── 发卡组合：能不能直接绑商品 ───────────────────────────
  {
    label: 'group/edit · product_id 存在？',
    path: '/api/open/kami/group/edit',
    body: { group_id: DEAD + 7, group_name: 'probe', product_id: 'not-a-number' },
  },
  {
    label: 'group/edit · goods_no 是 string？',
    path: '/api/open/kami/group/edit',
    body: { group_id: DEAD + 8, group_name: 'probe', goods_no: 12345 },
  },
  {
    label: 'group/edit · kind_group 数组结构',
    path: '/api/open/kami/group/edit',
    body: { group_id: DEAD + 9, group_name: 'probe', kind_group: 'not-an-array' },
  },
];

async function main() {
  const c = getClient();
  if (!c.configured) {
    console.error('❌ 未配置 AppKey/AppSecret（检查 .env）');
    process.exit(1);
  }
  console.log('探测目标：哪些"商品关联"字段真实存在于接口 schema 里');
  console.log('判据：msg 里出现 cannot unmarshal 且带字段名 = 字段存在\n');

  for (const p of probes) {
    try {
      const r = await c.call<unknown>(p.path, p.body);
      console.log(`· ${p.label}`);
      console.log(`    ⚠️ 意外成功：${JSON.stringify(r).slice(0, 200)}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const unmarshal = msg.match(/cannot unmarshal .*? field (\S+)/i);
      const unknownField = /unknown field|invalid field/i.test(msg);
      console.log(`· ${p.label}`);
      if (unmarshal) {
        console.log(`    ✅ 字段存在 → ${unmarshal[1]}`);
      } else if (unknownField) {
        console.log(`    ❌ 字段不存在 → ${msg.slice(0, 160)}`);
      } else {
        console.log(`    ?  ${msg.replace(/^\[[^\]]+\]\s*/, '').slice(0, 160)}`);
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log('\n说明：');
  console.log('  "✅ 字段存在" 表示接口会解析这个字段 → 有可能用它完成绑定');
  console.log('  "?" 一般是业务校验（如卡种不存在）先返回了，说明该字段被静默忽略');
}

void main();
