/**
 * 「管家视角」看货源商品清单。
 *
 * 用真实商户凭证签名后请求 goods/list，打印出来的就是闲管家在
 * 【卡密仓库 → 发货 → 关联商品】下拉里会看到的那份清单。
 *
 * 用途：新上架一个货源商品后，先在这里确认「管家能看到、价格库存都对」，
 * 再去后台操作，能省掉一轮来回猜测。
 *
 * 用法：
 *   npx tsx scripts/goods.ts                       # 默认打 http://127.0.0.1:8787
 *   npx tsx scripts/goods.ts https://xxx.trycloudflare.com
 */
import { opt } from '../packages/bdpan-core/src/env';
import { genVsSign } from '../packages/xgj-gateway/src/sign';

const argv = process.argv.slice(2);
const BASE = (argv.find((a) => !a.startsWith('--')) ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');

const APP_ID = opt('GOOFISH_APP_KEY');
const APP_SECRET = opt('GOOFISH_APP_SECRET');
const MCH_ID = opt('XGJ_MCH_ID');
const MCH_SECRET = opt('XGJ_MCH_SECRET');

const C = {
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  d: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

async function call(pathname: string, body: unknown) {
  const raw = JSON.stringify(body ?? {});
  const ts = Math.floor(Date.now() / 1000);
  const sign = genVsSign({
    appId: APP_ID,
    appSecret: APP_SECRET,
    mchId: MCH_ID,
    mchSecret: MCH_SECRET,
    timestamp: ts,
    bodyString: raw,
  });
  const url = BASE + pathname + `?mch_id=${encodeURIComponent(MCH_ID)}&timestamp=${ts}&sign=${sign}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: raw,
  });
  return { http: res.status, json: await res.json() };
}

const listBody = { keyword: '', goods_type: 2, page_no: 1, page_size: 100 };
const { http, json } = await call('/goofish/goods/list', listBody);

console.log('');
console.log(C.b(`=== 闲管家会看到的货源商品（${BASE}）===`));
console.log(C.d(`  请求体：${JSON.stringify(listBody)}`));
console.log('');

if (json.code !== 0) {
  console.log(C.r(`  ❌ code=${json.code} msg=${json.msg}`));
  process.exit(1);
}

const rows: any[] = json.data?.list ?? [];
console.log(`  HTTP ${http}   code=0   count=${json.data?.count}   本页 ${rows.length} 条`);
console.log('');
for (const g of rows) {
  const mode = g.stock_mode === 'shared' ? C.y('一链多发') : C.g('一单一链');
  console.log(`  ┌─ ${C.b(g.goods_no)}   ${g.goods_name}`);
  console.log(`  │  价格 ¥${(g.price / 100).toFixed(2)}   库存 ${g.stock}   状态 ${g.status === 1 ? '在架' : '下架'}   模式 ${mode}`);
  if (g.update_time) console.log(C.d(`  └─ 更新于 ${new Date(g.update_time * 1000).toLocaleString('zh-CN')}`));
  else console.log('  └─');
}
console.log('');
