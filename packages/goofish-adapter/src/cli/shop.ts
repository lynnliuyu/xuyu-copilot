/**
 * 查询闲鱼店铺与商家地址 —— 用来回填草稿里两个「必须联网才知道、手填极易错」的字段：
 *
 *   · publish_shop[].user_name        → 闲鱼**会员名**（形如 xy1234567890），不是店铺昵称
 *   · publish_shop[].province/city/district → 部分类目必填的省市区 ID
 *
 * 为什么会单独做这个命令：闲管家的报错不区分「会员名写错」和「店铺没授权」，
 * 手抄昵称进去只会得到一句含糊的失败。直接从店铺列表解析，就不给人抄错的机会。
 * 做法参考了同类接入实现：从 `/api/open/user/authorize/list` 取 user_name，
 * 省市区优先取商家默认地址（`/api/open/user/address/list`）。
 *
 * 用法：
 *   npm run gf:shop                        列出所有已授权店铺 + 商家地址
 *   npm run gf:shop -- --fill <草稿名>      把第一家有效店铺的会员名与省市区回填进草稿
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listShops, listAddresses } from '../api';
import { GOOFISH_APP_KEY, GOOFISH_APP_SECRET } from '../config';
import { GoofishError } from '../client';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DRAFTS_DIR = path.join(ROOT, 'drafts');

const line = (s = '') => process.stdout.write(s + '\n');
const b = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

/** 从任意形状里抠出一个 ID：支持 number、数字字符串、"110000" 以及 { id, name } 结构 */
function pickId(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  if (v && typeof v === 'object') {
    for (const k of ['id', 'value', 'code', 'province_id', 'city_id', 'district_id']) {
      const inner = (v as Record<string, unknown>)[k];
      const got = pickId(inner);
      if (got !== undefined) return got;
    }
  }
  return undefined;
}

/** 宽松解析省市区 —— 字段名在不同版本里叫法不一，全部试一遍 */
function extractRegion(addr: Record<string, unknown>): { province?: number; city?: number; district?: number } {
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const got = pickId(addr[k]);
      if (got !== undefined) return got;
    }
    return undefined;
  };
  return {
    province: get('province', 'province_id', 'provinceId'),
    city: get('city', 'city_id', 'cityId'),
    district: get('district', 'district_id', 'districtId', 'area'),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const fillIdx = argv.indexOf('--fill');
  const fillDraftName = fillIdx >= 0 ? argv[fillIdx + 1] : undefined;

  if (!GOOFISH_APP_KEY() || !GOOFISH_APP_SECRET()) {
    line('');
    line(red('  ✗ 未配置进销存凭证（GOOFISH_ERP_APP_KEY / GOOFISH_ERP_APP_SECRET）'));
    line('');
    process.exit(2);
  }

  line('');
  line(b('══════ 闲鱼店铺 / 商家地址 ══════'));
  line('');

  try {
    const shops = await listShops();

    line(b(`  已授权店铺（${shops.length} 家）`));
    if (!shops.length) {
      line(yellow('    ⚠️ 列表为空。该闲鱼店铺需先订购 ERP 专业版/铂金版并完成授权。'));
    }
    for (const s of shops) {
      const exp = s.authorize_expires
        ? new Date(Number(s.authorize_expires) * 1000).toISOString().slice(0, 10)
        : '未知';
      const days = s.authorize_expires
        ? Math.round((Number(s.authorize_expires) * 1000 - Date.now()) / 86400_000)
        : null;
      const expNote = days === null ? '' : days < 30 ? red(`（剩 ${days} 天，需尽快续授权）`) : dim(`（剩 ${days} 天）`);
      line('');
      line(`    ${cyan(s.user_name ?? '(无 user_name)')}   ${s.nick ?? s.shop_name ?? ''}`);
      line(`      user_id=${s.user_id ?? '-'}  authorize_id=${s.authorize_id ?? '-'}  到期 ${exp} ${expNote}`);
    }
    line('');
    line(dim('    ↑ 会员名（第二列）就是草稿 publish_shop[].user_name 该填的值'));

    // ---------- 商家地址 ----------
    line('');
    line(b('  商家地址'));
    let region: { province?: number; city?: number; district?: number } | undefined;
    try {
      const addrs = await listAddresses();
      if (!addrs.length) {
        line(dim('    （无地址返回，部分类目不要求省市区）'));
      }
      addrs.slice(0, 5).forEach((a, i) => {
        const r = extractRegion(a as Record<string, unknown>);
        if (!region && r.province) region = r;
        line(`    [${i}] ${JSON.stringify(a).slice(0, 160)}`);
        if (r.province) line(`        解析为 province=${r.province} city=${r.city ?? '-'} district=${r.district ?? '-'}`);
      });
    } catch (e) {
      line(dim(`    （地址接口不可用：${(e as Error).message.slice(0, 80)}）`));
    }

    // ---------- 回填草稿 ----------
    if (fillDraftName) {
      line('');
      line(b(`  回填草稿：${fillDraftName}`));
      const p = path.isAbsolute(fillDraftName)
        ? fillDraftName
        : path.join(DRAFTS_DIR, fillDraftName.endsWith('.json') ? fillDraftName : `${fillDraftName}.json`);
      if (!fs.existsSync(p)) {
        line(red(`    ✗ 草稿不存在：${p}`));
        line('');
        process.exit(2);
      }
      const draft = JSON.parse(fs.readFileSync(p, 'utf8'));

      const shop = shops.find((s) => s.user_name);
      if (!shop?.user_name) {
        line(red('    ✗ 没有可用的店铺会员名，无法回填'));
      } else {
        draft.publish_shop = draft.publish_shop?.length ? draft.publish_shop : [{}];
        let filled = 0;
        for (const s of draft.publish_shop) {
          if (!s.user_name) {
            s.user_name = shop.user_name;
            filled++;
          }
        }
        if (filled) line(green(`    ✅ user_name → ${shop.user_name}（${filled} 个店铺位）`));
        else line(dim(`    · user_name 已有值（${draft.publish_shop.map((s: any) => s.user_name).join(', ')}），未改动`));

        if (region?.province) {
          for (const s of draft.publish_shop) {
            if (!s.province) s.province = region!.province;
            if (!s.city) s.city = region!.city;
            if (!s.district) s.district = region!.district;
          }
          line(green(`    ✅ 省市区 → ${region.province} / ${region.city ?? '-'} / ${region.district ?? '-'}`));
        } else {
          line(dim('    · 未取到省市区，保持原值'));
        }
        fs.writeFileSync(p, JSON.stringify(draft, null, 2) + '\n');
        line(dim(`    已写回 ${path.relative(ROOT, p)}`));
        line('');
        line(`  下一步：${b(`npm run gf:preview ${fillDraftName}`)}  核对，类目 ID 用 gf:categories 查`);
      }
    } else {
      line('');
      line(dim('  提示：加 --fill <草稿名> 可自动把会员名与省市区写进草稿'));
    }
  } catch (e) {
    line('');
    if (e instanceof GoofishError) {
      line(red(`  ✗ 接口调用失败：${e.message}`));
      // ⚠️ 100001 是通用兜底码，必须看 msg 才能定性
      if (e.code === 100001 && /应用不存在或已下线/.test(e.message)) {
        line('');
        line(yellow('  应用不存在或已下线 —— 进销存应用必须**先在闲管家开放平台点「上线」**。'));
      } else if (e.code === 403) {
        line('');
        line(yellow('  IP 不在白名单 —— 去闲管家「我的应用」填入当前出口公网 IP。'));
      }
    } else {
      line(red(`  ✗ ${(e as Error).message}`));
    }
    line('');
    process.exit(1);
  }

  line('');
}

main().catch((e) => {
  line('');
  line(red(`  ✗ ${e.message}`));
  line('');
  process.exit(1);
});
