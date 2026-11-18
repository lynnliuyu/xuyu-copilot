#!/usr/bin/env node
/**
 * 为网盘条目批量创建**分享链接**（bdpan share，付费接口），并把结果记进台账。
 *
 * ⚠️ 为什么必须有台账：share 每调一次就在网盘里**新建一个分享**（不是幂等），
 *    重复跑会堆出一堆重复分享、还重复计费。所以：台账里有的一律跳过，绝不重复建。
 *
 * 用法：
 *   npm run share:netdisk -- --cat 软件            # 某个类目下所有产品目录
 *   npm run share:netdisk -- --only 软件/Maccy,软件/Stats
 *   npm run share:netdisk -- --all --limit 20
 *   npm run share:netdisk -- --cat 软件 --period 0  # 0=永久(默认) 1/7/30 天
 *   npm run share:netdisk -- --cat 软件 --dry       # 只看会建哪些，不真调接口
 *
 * 产物：out/netdisk-shares.json（台账）+ netdisk-site/shares.json（站点用）
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'out', 'netdisk-index.json');
const LEDGER = path.join(ROOT, 'out', 'netdisk-shares.json');
const SITE = path.join(ROOT, 'netdisk-site');
const BDPAN = path.join(os.homedir(), '.local', 'bin', 'bdpan');

const argv = process.argv.slice(2);
const val = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const has = (f) => argv.includes(f);
const PERIOD = Number(val('--period', '0'));
const DRY = has('--dry');
const LIMIT = Number(val('--limit', '0'));
const CONC = Number(val('--conc', '2'));

if (!fs.existsSync(INDEX)) {
  console.error('❌ 先跑 npm run tree:netdisk');
  process.exit(1);
}
const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : { shares: {} };
ledger.shares ||= {};

/* ---------------- 目标清单 ---------------- */
function walk(nodes, out = []) {
  for (const n of nodes) if (n.dir) { out.push(n); walk(n.children || [], out); }
  return out;
}
const allDirs = walk(idx.tree);
const only = (val('--only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const cat = val('--cat', '');

let targets;
if (val('--paths-file','')) targets = JSON.parse(fs.readFileSync(val('--paths-file',''))).map(path=>({path}));
else if (only.length) targets = allDirs.filter((n) => only.includes(n.path));
else if (cat) targets = allDirs.filter((n) => n.path.split('/')[0] === cat);
else if (has('--all')) targets = allDirs.filter(n => (n.children || []).length && !n.path.startsWith('00-资源池')); 
else {
  console.error('❌ 需要指定范围：--cat <类目> / --only <路径,路径> / --all');
  process.exit(1);
}
if (LIMIT) targets = targets.slice(0, LIMIT);

const todo = targets.filter((n) => !ledger.shares[n.path]);
console.log('══════ 创建分享链接 ══════');
console.log(`  范围：${cat || (only.length ? '--only' : '全部')}　目标 ${targets.length} 个　台账已有 ${targets.length - todo.length} 个　待建 ${todo.length} 个`);
console.log(`  有效期：${PERIOD === 0 ? '永久' : PERIOD + ' 天'}　并发 ${CONC}${DRY ? '　【dry-run】' : ''}`);

if (DRY) {
  for (const n of todo.slice(0, 40)) console.log(`  · ${n.path}（${(n.children || []).length} 个子项）`);
  if (todo.length > 40) console.log(`  … 其余 ${todo.length - 40} 个`);
  process.exit(0);
}

/* ---------------- 执行 ---------------- */
let ok = 0;
let fail = 0;
let retried = 0;
let i = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带重试的分享：实测并发下会有偶发失败（这次 752 个里挂了 2 个），重试即成功 */
async function shareOnce(p, tries = 1) {
  let lastErr;
  for (let t = 1; t <= tries; t++) {
    try {
      const { stdout } = await pexec(BDPAN, ['share', p, '-d', String(PERIOD), '--json'], {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, PATH: `${path.dirname(BDPAN)}:${process.env.PATH}` },
      });
      const j = JSON.parse(stdout.slice(stdout.indexOf('{')));
      if (!j.link) throw new Error(stdout.trim().slice(0, 120));
      if (t > 1) retried += 1;
      return j;
    } catch (e) {
      lastErr = e;
      if (t < tries) await sleep(800 * t);   // 退避一下再试，多半是限流/瞬时抖动
    }
  }
  throw lastErr;
}

async function worker() {
  while (i < todo.length) {
    const n = todo[i++];
    try {
      const j = await shareOnce(n.path);
      ledger.shares[n.path] = {
        link: j.link,
        short: j.short_url || '',
        pwd: j.pwd || '',
        period: PERIOD,
        share_id: j.share_id || '',
        at: new Date().toISOString().slice(0, 19),
      };
      ok += 1;
      console.log(`  ✅ ${n.path}　${j.link}${j.pwd ? `　提取码 ${j.pwd}` : ''}`);
      fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1), 'utf8');
    } catch (e) {
      fail += 1;
      ledger.errors ||= {}; ledger.errors[n.path] = String(e.message).split('\n')[0].slice(0,140);
      fs.writeFileSync(LEDGER, JSON.stringify(ledger,null,1));
      console.log(`  ✗ ${n.path} —— ${String(e.message).split('\n')[0].slice(0, 140)}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, CONC) }, worker));

/* ---------------- 落盘 ---------------- */
fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1), 'utf8');
const siteShares = {};
for (const [p, v] of Object.entries(ledger.shares)) siteShares[p] = { link: v.link, pwd: v.pwd, period: v.period };
fs.mkdirSync(SITE, { recursive: true });
fs.writeFileSync(path.join(SITE, 'shares.json'), JSON.stringify(siteShares, null, 1), 'utf8');

console.log('');
console.log(`汇总：成功 ${ok}　失败 ${fail}${retried ? `　（其中 ${retried} 个重试后成功）` : ''}　台账共 ${Object.keys(ledger.shares).length} 条`);
console.log(`  → out/netdisk-shares.json（台账，勿删）＋ netdisk-site/shares.json`);
console.log('  下一步：npm run site:netdisk 把链接并进站点数据');
