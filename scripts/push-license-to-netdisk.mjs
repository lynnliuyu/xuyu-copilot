#!/usr/bin/env node
/**
 * 把「授权说明」补进网盘上已存在的软件包目录
 *
 * ── 为什么需要它
 * `push-free-to-netdisk.mjs` 生成的 `使用说明.txt` 里只写了**许可证名称**（「许可　MIT」），
 * **不含许可证全文**。而 MIT 的唯一条义务就是「分发时必须附版权声明与许可证全文」——
 * 也就是说，只有 `使用说明.txt` 的包，在 MIT 意义上**是不合规的**。
 * GPL 系更严：还要求附源码获取方式。
 *
 * 四篇文章的 ⑩ 节都承诺了「授权说明/：LICENSE 全文 + 本包说明」，这个脚本负责把承诺兑现。
 *
 * ── 数据来源
 *   映射：out/netdisk-map.json（网盘文件夹名 → 项目 id，由 share:sync 生成）
 *   正文：out/netdisk-license/<id>/{LICENSE-原文.txt, SOURCE-获取方式.txt, 本包说明.txt}
 *        （由 make-source-note.mjs 生成；许可证正文来自本地体检缓存，不联网、不编造）
 *
 * ── 行为
 *   · **只新增文件，绝不删除或覆盖已有内容**
 *   · 上传前先 `ls` 目标目录，**已存在的同名文件跳过** → 可安全重跑，不产生 (1) 副本
 *   · 缺哪个文件就报哪个，不静默跳过
 *
 * 用法：
 *   node scripts/push-license-to-netdisk.mjs --dry              # 只看会传什么
 *   node scripts/push-license-to-netdisk.mjs                    # 真正上传
 *   node scripts/push-license-to-netdisk.mjs --only Maccy,Stats # 只做几个
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const MAP = path.join(ROOT, 'out', 'netdisk-map.json');
const SRC = path.join(ROOT, 'out', 'netdisk-license');
const BDPAN = fs.existsSync(path.join(os.homedir(), '.local', 'bin', 'bdpan'))
  ? path.join(os.homedir(), '.local', 'bin', 'bdpan')
  : 'bdpan';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const REMOTE_ROOT = process.env.NETDISK_FREE_DIR || '软件';
const SUBDIR = '授权说明';
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(',').map((s) => s.trim()) : [];
})();

if (!fs.existsSync(MAP)) {
  console.error('❌ 缺 out/netdisk-map.json —— 先跑 npm run share:sync');
  process.exit(1);
}
const map = JSON.parse(fs.readFileSync(MAP, 'utf8')).map || {};
const entries = Object.entries(map).filter(([name]) => !ONLY.length || ONLY.includes(name));
if (!entries.length) {
  console.error('没有可处理的条目');
  process.exit(1);
}

const run = (args) =>
  execFileSync(BDPAN, args, {
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, PATH: `${path.dirname(BDPAN)}:${process.env.PATH}` },
  });

/** 目标目录里已有的文件名（目录不存在返回 null） */
function listDir(remoteDir) {
  try {
    const out = run(['ls', remoteDir, '--json']);
    const j = JSON.parse(out.slice(out.indexOf('[')));
    return j.filter((x) => !x.isdir).map((x) => x.server_filename);
  } catch {
    return null;
  }
}

console.log('══════ 补「授权说明」到网盘 ══════');
console.log(`  来源：${path.relative(ROOT, SRC)}／<项目 id>/`);
console.log(`  目标：${REMOTE_ROOT}/<产品名>/${SUBDIR}/`);
console.log(`  条目：${entries.length} 个${DRY ? '　【dry-run】' : ''}\n`);

let uploaded = 0;
let skipped = 0;
let missing = 0;
let failed = 0;
const problems = [];

for (const [name, id] of entries) {
  const srcDir = path.join(SRC, id);
  const remoteDir = `${REMOTE_ROOT}/${name}/${SUBDIR}`;

  if (!fs.existsSync(srcDir)) {
    failed++;
    problems.push(`${name}：本地没有 out/netdisk-license/${id}/（先跑 make-source-note.mjs）`);
    console.log(`  ✗ ${name.padEnd(18)} 本地无生成物 out/netdisk-license/${id}/`);
    continue;
  }

  const files = fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith('.txt'))
    .sort((a, b) => (a === 'LICENSE-原文.txt' ? -1 : b === 'LICENSE-原文.txt' ? 1 : a.localeCompare(b)));

  const existing = listDir(remoteDir);
  if (existing === null && !DRY) {
    try {
      run(['mkdir', remoteDir]);
    } catch {
      /* 目录已存在会报错，忽略 */
    }
  }

  const todo = files.filter((f) => !(existing || []).includes(f));
  const done = files.length - todo.length;
  skipped += done;
  if (!files.length) missing++;

  const marks = [];
  for (const f of todo) {
    if (DRY) { marks.push(`＋${f}`); continue; }
    try {
      run(['upload', path.join(srcDir, f), `${remoteDir}/${f}`]);
      uploaded++;
      marks.push(`＋${f}`);
    } catch (e) {
      failed++;
      marks.push(`✗${f}`);
      problems.push(`${name}/${f}：${String(e.message).split('\n')[0].slice(0, 90)}`);
    }
  }
  if (done) marks.unshift(`已存在 ${done} 个，跳过`);

  console.log(`  ${failed ? '✗' : '·'} ${name.padEnd(18)} ${marks.join('　') || '（无可传文件）'}`);
}

console.log('');
console.log(`汇总：上传 ${uploaded}　跳过（已存在）${skipped}　缺文件 ${missing}　失败 ${failed}`);
if (problems.length) {
  console.log('\n⚠️ 需要处理：');
  problems.forEach((p) => console.log('   -', p));
}
if (DRY) console.log('\n（dry-run 结束，未上传）');
else {
  console.log('\n提示：网盘目录变了，可跑 npm run tree:netdisk 刷新索引；分享链接不受影响');
  console.log('（百度按 fs_id 记录分享，新增文件不需要重建分享）。');
}
