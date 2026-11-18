/**
 * 审计：线上已发布商品的图，到底挂在哪个域名。
 *
 * 背景：`api.fmkj.top` 已被别的服务（New API）占用，现在对 `/goods/*.png`
 * 返回的是 **1047 字节的 HTML 首页**，不是图片。而线上商品图仍指向它。
 *
 * 只读：只调 `product/detail`，不改任何东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProduct } from '../packages/goofish-adapter/src/api';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const led = JSON.parse(fs.readFileSync(path.join(ROOT, 'drafts', '.listings.json'), 'utf8')) as Record<
  string,
  { product_id?: number; title?: string; state?: string }
>;

interface Row {
  code: string;
  product_id: number;
  title: string;
  shop: string;
  host: string;
  image: string;
}

async function main() {
  const entries = Object.entries(led).filter(([, v]) => v.product_id);
  console.log(`待审计 ${entries.length} 个商品（逐个 detail，只读）\n`);

  const rows: Row[] = [];
  const errs: string[] = [];
  let i = 0;

  for (const [code, v] of entries) {
    i++;
    if (i % 50 === 0) process.stdout.write(`  …${i}/${entries.length}\n`);
    try {
      const d = (await getProduct(Number(v.product_id))) as never as {
        publish_shop?: Array<{ user_name?: string; images?: string[] }>;
      };
      for (const ps of d.publish_shop ?? []) {
        const img = String((ps.images ?? [])[0] ?? '');
        const host = img ? img.replace(/^https?:\/\//, '').split('/')[0] : '(无图)';
        rows.push({
          code,
          product_id: Number(v.product_id),
          title: String(v.title ?? ''),
          shop: String(ps.user_name ?? ''),
          host,
          image: img,
        });
      }
    } catch (e: unknown) {
      errs.push(`${code}: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    }
  }

  const byHost: Record<string, number> = {};
  const byShopHost: Record<string, number> = {};
  for (const r of rows) {
    byHost[r.host] = (byHost[r.host] ?? 0) + 1;
    const k = `${r.host} @ ${r.shop}`;
    byShopHost[k] = (byShopHost[k] ?? 0) + 1;
  }

  console.log('\n=== 线上图域名分布 ===');
  for (const [k, n] of Object.entries(byHost).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(26)} ${String(n).padStart(5)}`);
  }
  console.log('\n=== 按店铺 ===');
  for (const [k, n] of Object.entries(byShopHost).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(42)} ${String(n).padStart(5)}`);
  }

  const broken = rows.filter((r) => r.host === 'api.fmkj.top');
  console.log(`\n需要修（图指向已失效的 api.fmkj.top）：${broken.length} 条 publish_shop`);
  if (errs.length) console.log(`读取失败 ${errs.length} 个：${errs.slice(0, 3).join(' | ')}`);

  fs.writeFileSync(
    path.join(ROOT, 'out', 'image-host-audit.json'),
    JSON.stringify({ at: new Date().toISOString(), byHost, rows }, null, 2),
    'utf8',
  );
  console.log('\n明细已写入 out/image-host-audit.json');
}

void main().catch((e) => console.error('💥', e instanceof Error ? e.message : e));
