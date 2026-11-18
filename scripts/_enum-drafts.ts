/** 临时工具：枚举台账里 state=draft 的商品，统计 publish_shop 数量与 item_id。
 *  用法：GOOFISH_LIVE=true npx tsx scripts/_enum-drafts.ts */
import fs from 'node:fs';
import path from 'node:path';
import { getProduct } from '../packages/goofish-adapter/src/api';

const file = path.join(process.cwd(), 'drafts/.listings.json');
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const arr: any[] = Array.isArray(raw) ? raw : Object.values(raw);
const drafts = arr.filter((x) => x.state === 'draft');
console.log(`draft 总数 ${drafts.length}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let clean = 0, dup = 0, onSale = 0, err = 0;
const dupList: string[] = [];
const onSaleList: string[] = [];
const errList: string[] = [];

for (let i = 0; i < drafts.length; i++) {
  const d = drafts[i];
  const pid = Number(d.product_id);
  try {
    const p: any = await getProduct(pid);
    const shops: any[] = p.publish_shop ?? [];
    const itemIds = shops.map((s) => Number(s.item_id ?? 0));
    if (itemIds.some((v) => v > 0)) {
      onSale++;
      onSaleList.push(`${pid} ${d.title}`);
    } else if (shops.length > 1) {
      dup++;
      dupList.push(`${pid} shops=${shops.length} ${d.title}`);
    } else {
      clean++;
    }
  } catch (e: any) {
    err++;
    errList.push(`${pid} ${e?.message ?? e}`);
  }
  if ((i + 1) % 20 === 0) console.log(`  ...${i + 1}/${drafts.length} clean=${clean} dup=${dup} onSale=${onSale} err=${err}`);
  await sleep(220);
}

console.log(`\n=== 结果 ===\n干净卡草稿(1店铺,item_id=0) = ${clean}`);
console.log(`重复 publish_shop(>1 店铺) = ${dup}`);
console.log(`实际已上架(item_id>0) = ${onSale}`);
console.log(`查询失败 = ${err}`);
if (dupList.length) console.log(`\n[重复 publish_shop 清单]\n${dupList.join('\n')}`);
if (onSaleList.length) console.log(`\n[实际已上架清单]\n${onSaleList.join('\n')}`);
if (errList.length) console.log(`\n[查询失败清单]\n${errList.join('\n')}`);
