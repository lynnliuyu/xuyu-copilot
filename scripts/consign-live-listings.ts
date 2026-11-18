import fs from 'node:fs';
import { listProducts } from '../packages/goofish-adapter/src/api';
const local=JSON.parse(fs.readFileSync('drafts/.listings.json','utf8'));
const byPid=new Map(Object.entries(local).map(([code,row]:[string,any])=>[Number(row.product_id),code]));
const live:Record<string,unknown>={};const unmapped:unknown[]=[];let total=0;
for(let page=1;page<=20;page++){
 const r:any=await listProducts({page_no:page,page_size:50,product_status:22});
 const list=r.list||[];total+=list.length;
 for(const p of list){const code=byPid.get(Number(p.product_id));if(code)live[code]={...local[code],...p,state:'on_sale'};else unmapped.push({product_id:p.product_id,title:p.title,outer_id:p.outer_id});}
 console.log('已查询在售商品',total,'已映射',Object.keys(live).length);
 if(list.length<50 || (r.total && total>=r.total))break;
}
fs.writeFileSync('out/consign-live-listings.json',JSON.stringify(live,null,2));
fs.writeFileSync('out/consign-live-unmapped.json',JSON.stringify(unmapped,null,2));
console.log('只读查询结束，未改动原台账');
