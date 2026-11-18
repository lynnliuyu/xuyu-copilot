#!/usr/bin/env node
/**
 * 改公众号名字 —— **一处输入，全库同步**。
 *
 * 背景：模板里的账号名原本散在 9 个文件里（4 张封面规格、1 条视频规格、配置、脚本、2 份文档）。
 * 改一次名要手工改 9 处，必然漏。这个脚本把旧名读出来、新名写进去，并报告每一处。
 *
 * ⚠️ **公众号名称一年只能改 2 次**（个人未认证主体）。改名前先把名字想清楚。
 *    本脚本只改**本地模板**，不碰微信后台 —— 后台那一步必须你本人扫码。
 *
 * ── 用法
 *   npm run rename:account -- "繁梦开源小仓库"          # 真实写入
 *   npm run rename:account -- "繁梦开源小仓库" --dry     # 只看会改哪几处
 *
 * ── 改完还要做两件事（脚本会提醒）
 *   1. 重出产物：npm run mp -- --all　&&　npm run video:cards -- assets/video-specs/maccy.json
 *   2. Ardot 画板 4 处底栏落款 —— 那个没有接口，只能手工改
 */
import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = path.join(ROOT, 'assets', 'mp-config.json');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const NAME = argv.find((a) => !a.startsWith('--'));

const line = (s = '') => console.log(s);
const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

if (!NAME) {
  console.error(red('用法：npm run rename:account -- "新名字" [--dry]'));
  process.exit(1);
}

/* ------------------------------------------------- 先验规则（别把额度浪费在审核上） */

const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const OLD = cfg.account;

// 官方：4–30 字符（1 个汉字算 2 字符），只允许中文、英文、数字
const chars = [...NAME].reduce((n, c) => n + (/[\u4e00-\u9fff]/.test(c) ? 2 : 1), 0);
const checks = [
  ['长度 4–30 字符（1 汉字＝2）', chars >= 4 && chars <= 30, `${chars} 字符`],
  ['只含中文 / 英文 / 数字', /^[\u4e00-\u9fff A-Za-z0-9]+$/.test(NAME), ''],
  ['不含「公众号」三字', !NAME.includes('公众号'), '平台保留词'],
  ['首尾无空格、中间不连续空格', NAME === NAME.trim() && !/\s{2,}/.test(NAME), ''],
];

line('');
line(b('══════ 改公众号名（本地模板同步）══════'));
line(`  旧名  ${OLD}`);
line(`  新名  ${NAME}`);
line('');

let bad = 0;
for (const [label, ok, note] of checks) {
  if (!ok) bad++;
  line(`  ${ok ? green('✅') : red('✗')} ${label}${note ? dim(`（${note}）`) : ''}`);
}

if (bad) {
  line('');
  line(red('  名字不合规，先改名字再跑。'));
  line('');
  process.exit(1);
}

line('');

/* ------------------------------------------------- 白名单：只动这几类文件 */

const TARGETS = [
  'assets/mp-config.json',
  'assets/mp-covers/*.json',
  'assets/video-specs/*.json',
  'scripts/article-to-mp.mjs',
  'scripts/mp-wechat-draft.mjs',
  'docs/*.md',
  'articles/*.md',
  'out/promo/*.md',
];

const files = [];
for (const pat of TARGETS) files.push(...globSync(pat, { cwd: ROOT }));

let touched = 0, hits = 0;
const skipped = [];

for (const rel of [...new Set(files)].sort()) {
  const abs = path.join(ROOT, rel);
  let txt;
  try {
    txt = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const n = txt.split(OLD).length - 1;
  if (!n) continue;

  hits += n;
  touched++;
  line(`  ${green('·')} ${rel}　${dim(`${n} 处`)}`);
  if (!DRY) fs.writeFileSync(abs, txt.split(OLD).join(NAME), 'utf8');
}

line('');

/* ------------------------------------------------- 常驻服务里的文案也要看一眼 */

try {
  const out = execFileSync('grep', ['-rln', OLD, 'scripts/lib'], { cwd: ROOT, encoding: 'utf8' });
  if (out.trim()) skipped.push(`scripts/lib/ 里还有旧名（客服回复文案）：${out.trim().split('\n').join(' ')}`);
} catch {
  /* grep 无匹配会退 1，属正常 */
}

line(b('汇总'));
line(`  命中 ${green(String(hits))} 处 / ${touched} 个文件　${DRY ? yellow('（dry-run，未写入）') : ''}`);
if (hits === 0) line(yellow('  ⚠️ 一处都没命中 —— 确认旧名拼写是否与 mp-config.json 里一致'));

if (skipped.length) {
  line('');
  line(yellow('  需要你手工确认：'));
  for (const s of skipped) line(`    · ${s}`);
}

line('');
line(b('改完还得做这三件事'));
line('  1. 重出产物（封面/操作台都带旧落款）：');
line(dim('       npm run mp -- --all'));
line(dim('       npm run video:cards -- assets/video-specs/maccy.json'));
line('  2. Ardot 画板 4 处底栏落款 —— 没有接口，只能手工改');
line('  3. 已推进草稿箱的那条，作者字段是推的时候固化的，需要重推：');
line(dim('       npm run mp:draft -- maccy'));
line('');
line(dim('  ⚠️ 微信后台改名要主体本人扫码，且名称有 24 小时确认期 —— 这一步脚本替不了。'));
line('');
