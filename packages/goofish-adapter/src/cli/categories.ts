/**
 * 查询闲鱼商品类目与类目属性 —— 用于回填草稿里的 channel_cat_id / channel_pv。
 *
 * 用法：
 *   npm run gf:categories                       列出「普通商品 / 其他」类目
 *   npm run gf:categories -- 2 99               指定 item_biz_type=2, sp_biz_type=99
 *   npm run gf:categories -- 2 99 --kw 设计      按关键词过滤类目名（强烈建议，99 下有几百个）
 *   npm run gf:categories -- 2 99 <catId>       钻取该类目的必填属性
 *
 * 为什么需要 --kw：`sp_biz_type=99（其他）` 是个垃圾筐，实测一次返回 900KB+、几百个类目，
 * 不做过滤根本没法看。先按业务关键词（设计/软件/素材…）收敛，再钻属性。
 *
 * ⚠️ 实测发现（2026-10-07）：类目名字段是 `channel_cat_name`，`name` 为空 ——
 * 早期按 `name` 解析导致整个列表只显示一串 hash ID，完全不可用。
 */
import { listCategories, listProperties } from '../api';
import { ITEM_BIZ_TYPE, SP_BIZ_TYPE } from '../endpoints';
import { GOOFISH_APP_KEY, GOOFISH_APP_SECRET } from '../config';
import type { CategoryNode, CategoryProperty } from '../types';

const line = (s = '') => process.stdout.write(s + '\n');
const b = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

/** 类目名字段可能叫 channel_cat_name（实测）也可能叫 name（早期假设），都要兼容 */
const catName = (n: CategoryNode) => n.channel_cat_name ?? n.name ?? '';

function flatten(nodes: CategoryNode[], depth = 0, out: Array<{ node: CategoryNode; depth: number }> = []) {
  for (const n of nodes) {
    out.push({ node: n, depth });
    if (n.children?.length) flatten(n.children, depth + 1, out);
  }
  return out;
}

/** 解析 argv：把 --kw/-k 及其值摘出来，剩下的当位置参数（避免关键词被当成 catId） */
function parseArgv(raw: string[]): { positional: string[]; kw?: string; all: boolean } {
  const positional: string[] = [];
  let kw: string | undefined;
  let all = false;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--kw' || a === '-k') {
      kw = raw[i + 1];
      i++;
      continue;
    }
    if (a === '--all') {
      all = true;
      continue;
    }
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  return { positional, kw, all };
}

async function main() {
  const { positional, kw, all } = parseArgv(process.argv.slice(2));
  const itemBizType = Number(positional[0] ?? 2);
  const spBizType = positional[1] !== undefined ? Number(positional[1]) : undefined;
  const catId = positional[2];

  if (!GOOFISH_APP_KEY() || !GOOFISH_APP_SECRET()) {
    line('');
    line(red('  ✗ 未配置进销存凭证（GOOFISH_ERP_APP_KEY / GOOFISH_ERP_APP_SECRET）'));
    line('');
    process.exit(2);
  }

  line('');
  line(b('══════ 闲鱼商品类目查询 ══════'));
  line(`  商品类型 item_biz_type = ${itemBizType}  ${dim(ITEM_BIZ_TYPE[itemBizType] ?? '未知')}`);
  if (spBizType !== undefined) line(`  行业类型 sp_biz_type   = ${spBizType}  ${dim(SP_BIZ_TYPE[spBizType] ?? '未知')}`);
  if (kw) line(`  关键词过滤             = ${cyan(kw)}`);
  line('');

  const params = {
    item_biz_type: itemBizType,
    ...(spBizType !== undefined ? { sp_biz_type: spBizType } : {}),
  };

  const cats = await listCategories(params);
  const flat = flatten(cats);

  const matched = kw ? flat.filter(({ node }) => catName(node).includes(kw)) : flat;

  line(
    b(`  类目树：共 ${flat.length} 个节点`) +
      (kw ? `，匹配「${kw}」${matched.length} 个` : ''),
  );
  line('');

  if (!flat.length) {
    line(red('  ✗ 返回为空。检查 item_biz_type / sp_biz_type 组合是否有效。'));
    line(dim('    已知行业类型：' + Object.entries(SP_BIZ_TYPE).map(([k, v]) => `${k}=${v}`).join('  ')));
    line('');
    return;
  }

  if (!matched.length) {
    line(yellow(`  ⚠️ 没有类目名包含「${kw}」。换关键词，或去掉 --kw 看全部（会很长）。`));
    line('');
    return;
  }

  const LIMIT = all || kw ? 200 : 60;
  for (const { node, depth } of matched.slice(0, LIMIT)) {
    const pad = '  '.repeat(depth + 1);
    const hasChildren = Boolean(node.children?.length);
    const leafMark = hasChildren ? '' : ' \x1b[32m← 叶子类目（可直接用）\x1b[0m';
    line(`  ${pad}${cyan(node.channel_cat_id)}  ${catName(node)}${leafMark}`);
  }
  if (matched.length > LIMIT) {
    line('');
    line(dim(`  …另有 ${matched.length - LIMIT} 个未显示。用 --kw 收窄，或加 --all 看全。`));
  }
  line('');

  // ---------- 钻取指定类目的属性 ----------
  if (catId) {
    line(b(`  类目 ${catId} 的属性`));
    const props = await listProperties({ ...params, channel_cat_id: catId });
    if (!props.length) line(dim('  （无属性返回）'));
    const required = props.filter((p) => p.required);
    const optional = props.filter((p) => !p.required);
    if (required.length) {
      line('');
      line(`  ${red('必填属性（缺任一则创建商品失败）')}`);
      for (const p of required) printProp(p, 2);
    }
    if (optional.length) {
      line('');
      line(`  选填属性（${optional.length} 项）`);
      for (const p of optional.slice(0, 20)) printProp(p, 2);
      if (optional.length > 20) line(dim(`    …另有 ${optional.length - 20} 项`));
    }
    line('');
    line(b('  可直接粘进草稿的 channel_pv 骨架（把 value_id 换成你要的值）：'));
    const skeleton = [...required, ...optional.slice(0, 1)]
      .filter((p) => p.value_list?.length)
      .slice(0, 4)
      .map((p) => ({
        property_id: p.property_id,
        property_name: p.property_name,
        value_id: p.value_list![0].value_id,
        value_name: p.value_list![0].value_name,
      }));
    line(JSON.stringify(skeleton, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
  } else {
    line(dim('  提示：加上第三个参数（类目 ID）可查看该类目的必填属性。例：'));
    line(dim(`    npm run gf:categories -- ${itemBizType} ${spBizType ?? 0} ${cyan(matched[0]?.node.channel_cat_id ?? '<catId>')}`));
  }
  line('');
}

function printProp(p: CategoryProperty, indent: number) {
  const pad = '  '.repeat(indent);
  line(`  ${pad}${p.required ? '\x1b[31m*\x1b[0m' : ' '} ${p.property_id}  ${p.property_name}`);
  if (p.value_list?.length) {
    const vals = p.value_list.map((v) => `${v.value_name}(${v.value_id})`).join(' | ');
    line(`  ${pad}    ${dim(vals.slice(0, 160))}${vals.length > 160 ? ' …' : ''}`);
  }
}

main().catch((e) => {
  line('');
  line(red(`  ✗ ${e.message}`));
  line('');
  process.exit(1);
});
