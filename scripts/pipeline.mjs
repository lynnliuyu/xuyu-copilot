#!/usr/bin/env node
/**
 * 全链路编排：采集器 → 出链 → 建商品 → 出图 → 发布 → 灌卡密池。
 *
 * 为什么要有它：这 5 步**顺序不能乱**，而且有两个隐式依赖很容易踩：
 *   · render-covers 从「资源条目」读数据 → 必须先跑 import-resources，
 *     否则一个资源都渲染不出来（现象是"没有需要渲染的资源"，看起来像 bug）
 *   · card-sync 要读「已上架台账」→ 必须在发布之后跑，
 *     否则刚发的商品在卡密池里没有内容（= 卖了发不出货）
 *
 * 用法：
 *   node scripts/pipeline.mjs --collector assets/gfxcamp-3dmodel --category 3d-model \
 *        --noun "3D模型素材" --subdir "3D模型" [--brand "繁梦空间 · 模型"] \
 *        [--batch 20] [--every 60] [--skip-sandbox] [--skip-publish] [--dry]
 *
 * 各步骤都可以单独跑，本脚本只是把参数与顺序固定下来：
 *   1) node scripts/sandbox-share.mjs   --collector … --subdir … --limit N
 *   2) npx tsx scripts/import-resources.ts --collector … --category … --noun …
 *   3) npx tsx scripts/render-covers.mjs   --collector … --noun … --pending
 *   4) node scripts/drip-publish.mjs    --every … --limit N --category …
 *   5) npx tsx scripts/card-sync.ts
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, dft = '') => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : dft;
};

const COLLECTOR = valOf('--collector');
const CATEGORY = valOf('--category');
const NOUN = valOf('--noun');
const SUBDIR = valOf('--subdir');
const BRAND = valOf('--brand');
const BATCH = valOf('--batch', '20');
const EVERY = valOf('--every', '60');
const DRY = has('--dry');
const SKIP_SANDBOX = has('--skip-sandbox');
const SKIP_PUBLISH = has('--skip-publish');

for (const [k, v] of [['--collector', COLLECTOR], ['--category', CATEGORY], ['--noun', NOUN], ['--subdir', SUBDIR]]) {
  if (!v && !(k === '--subdir' && SKIP_SANDBOX)) {
    console.error(`❌ 缺少 ${k}\n用法见本文件顶部注释。`);
    process.exit(1);
  }
}

function run(title, cmd, args) {
  return new Promise((resolve, reject) => {
    console.log(`\n${'─'.repeat(64)}\n▶ ${title}\n  ${cmd} ${args.join(' ')}\n${'─'.repeat(64)}`);
    if (DRY) { console.log('  （--dry：跳过执行）'); return resolve(); }
    const child = spawn(cmd, args, { cwd: PROJ, stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${title} 失败，退出码 ${code}`))));
  });
}

const steps = [];
if (!SKIP_SANDBOX) {
  steps.push(['1/5 转存进沙箱并生成永久链接', 'node',
    ['scripts/sandbox-share.mjs', '--collector', COLLECTOR, '--subdir', SUBDIR, '--limit', BATCH, '--skip-usage']]);
}
steps.push(['2/5 建资源条目 + 生成发布草稿', 'npx',
  ['tsx', 'scripts/import-resources.ts', '--collector', COLLECTOR, '--category', CATEGORY, '--noun', NOUN]]);
steps.push(['3/5 渲染商品图 + 上传图床 + 回填', 'npx',
  ['tsx', 'scripts/render-covers.mjs', '--collector', COLLECTOR, '--noun', NOUN,
   ...(BRAND ? ['--brand', BRAND] : []), '--pending']]);
if (!SKIP_PUBLISH) {
  steps.push(['4/5 节流发布', 'node',
    ['scripts/drip-publish.mjs', '--every', EVERY, '--limit', BATCH, '--category', CATEGORY]]);
}
steps.push(['5/5 灌卡密池（发货闭环）', 'npx', ['tsx', 'scripts/card-sync.ts']]);

console.log(`全链路：采集器 ${COLLECTOR}　类别 ${CATEGORY}　批次 ${BATCH} 个${DRY ? '　【dry-run】' : ''}`);
for (const [title, cmd, args] of steps) {
  try {
    await run(title, cmd, args);
  } catch (e) {
    console.error(`\n❌ 中断：${e.message}`);
    console.error('   已完成的步骤是幂等的，修好后重跑本脚本即可（不会重复建条目/重复发商品）。');
    process.exit(1);
  }
}

console.log('\n✅ 全链路完成。');
console.log('   人工后续：闲管家后台 →「卡密仓库」→ 为每个闲鱼商品选中对应货源商品并关联（官方流程，无法自动化）。');
