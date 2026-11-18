#!/usr/bin/env node
/**
 * 把「**多平台**」项目的官方包整理进百度网盘。
 *
 * ── 与 push-free-to-netdisk.mjs 的分工（别混用）
 *   `push:free`  —— 单平台条目：一个项目一个包，命名固定 `- mac版`。历史 20 个条目走它。
 *   `push:multi` —— 多平台条目：一个项目多个平台的包，见
 *                   `assets/free-software/multiplatform.json`。本文件。
 *   两者都会写 `软件/<产品名>/`，但**各管各的条目**，同一条目只会被其中一个处理
 *   （判据：`out/free-software.json` 里该条目有没有 `files[]`）。
 *
 * ── 命名规范（沿用 docs/软件资源分类与采集方案.md 第六节）
 *   `软件/<产品名>/<产品名> <版本> - <平台>版(<架构>).<ext>`
 *   · 平台档写进名字：mac版 / win版 / linux版 / 安卓版 / 源码包
 *   · **架构写清楚**：同一平台有多个包时尤其关键（OBS 的 Apple芯片 / Intel）
 *   · **版本号必须进文件名**
 *   · 避开「破解 / 免费 / 永久 / 全网最低 / 可商用」等限流词
 *
 * ── 用法
 *   npm run push:multi                 # 真正上传
 *   npm run push:multi -- --dry        # 只预览会传哪些、叫什么名
 *   npm run push:multi -- --only obs-studio,appflowy
 *
 * 幂等：上传前先 `bdpan ls` 看目录里有没有同名文件，有就跳过。**只新增，不删改。**
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULT = path.join(ROOT, 'out', 'free-software.json');
const MULTI_FILE = path.join(ROOT, 'assets', 'free-software', 'multiplatform.json');
const STAGE = path.join(ROOT, 'out', 'multi-bundle');
const REMOTE_ROOT = process.env.NETDISK_FREE_DIR || '软件';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const DRY = has('--dry');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]).split(',').map((s) => s.trim()) : [];
})();

const line = (s = '') => console.log(s);
const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const BDPAN = (() => {
  const p = path.join(os.homedir(), '.local', 'bin', 'bdpan');
  return fs.existsSync(p) ? p : 'bdpan';
})();

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

function tryRun(args) {
  try {
    return { out: sh(BDPAN, args), err: null };
  } catch (e) {
    return { out: e?.stdout ?? '', err: `${e?.stderr ?? ''}${e?.message ?? ''}`.trim() };
  }
}

/* ---------------------------------------------------------------- 平台标签 */

const LABELS = (() => {
  const f = JSON.parse(fs.readFileSync(MULTI_FILE, 'utf8'));
  return f._labels || { mac: 'mac版', win: 'win版', linux: 'linux版', android: '安卓版', source: '源码包' };
})();

/** 版本号显示：去掉 tag 上的 `v` 前缀（`v1.18.2` → `1.18.2`），让同目录下命名一致 */
const verLabel = (v) => String(v || '').replace(/^v(?=\d)/i, '');

/** 取扩展名：`.tar.gz` / `.tar.xz` 这类复合后缀必须整体保留（`path.extname` 只给 `.gz`，会丢信息） */
function extOf(name) {
  const m = String(name).match(/\.tar\.(gz|xz|bz2|zst)$/i);
  return m ? m[0] : path.extname(name) || '';
}

const INSTALL_STEPS = {
  mac: [
    '.dmg 双击挂载（.zip 双击解压）',
    '把里面的 App 拖进「应用程序」文件夹',
    '首次打开若提示「无法验证开发者」：在「应用程序」里【右键】点它 → 选「打开」→ 再点一次「打开」',
  ],
  win: [
    '.exe 双击安装；.zip 解压后直接运行里面的 exe',
    '若弹出 SmartScreen 警告：点「更多信息」→「仍要运行」',
    '安装类项目建议勾选「仅为当前用户安装」，避免要管理员权限',
  ],
  linux: [
    '.deb 双击安装，或终端执行：sudo apt install ./文件名.deb',
    '.AppImage 先加执行权限再双击：chmod +x 文件名.AppImage',
    '.tar.gz 解压后按目录内说明运行',
  ],
  android: [
    '把 apk 传到手机后点击安装',
    '系统会提示「未知来源」：在设置里允许该来源安装即可（这是官方原包，不是第三方改包）',
  ],
  source: [
    '这是**源码包**，需要自行编译（面向开发者）',
    '编译方式以官方仓库的构建说明为准',
  ],
};

/* ---------------------------------------------------------------- 说明文件 */

function readmeMulti(it, rows) {
  const home = it.homepage || '';
  const ver = verLabel(it.version);
  const list = rows
    .map((r) => `  ${r.file}\n    ${r.platformCn}${r.arch ? `　${r.arch}` : ''}　${(r.bytes / 1048576).toFixed(1)} MB\n    SHA256　${r.sha256}${r.verified === true ? '　✅ 已与官方校验值一致' : ''}`)
    .join('\n');

  const platforms = [...new Set(rows.map((r) => r.platform))];
  const steps = platforms
    .map((p) => `【${LABELS[p] || p}】\n${(INSTALL_STEPS[p] || []).map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`)
    .join('\n');

  return `【${it.name} ${ver}】${it.cn}

■ 这是什么
${(it.usage || []).join('\n')}

■ 包含内容（共 ${rows.length} 个文件）
${list}

■ 安装
${steps}

■ 来源与许可
  官方页面　${home}
  许可　　　${it.license || ''}
  本包均为**官方原版安装包**，未做任何改动，可直接与官方校验值比对。

■ 说明
  本整理只是把官网的安装包放到更方便获取的位置，方便离线安装与学习使用。
  软件著作权归原作者所有；如需长期使用或商用，请以官方渠道为准。

■ 整理日期
  ${new Date().toISOString().slice(0, 10)}
`;
}

/* ------------------------------------------------------------------ 主流程 */

if (!fs.existsSync(RESULT)) {
  console.error(red(`❌ 找不到 ${path.relative(ROOT, RESULT)} —— 先跑 npm run fetch:free`));
  process.exit(1);
}

const got = JSON.parse(fs.readFileSync(RESULT, 'utf8'));
let items = got.items.filter((x) => x.status === 'downloaded' && Array.isArray(x.files) && x.files.length);
if (ONLY.length) items = items.filter((x) => ONLY.includes(x.id));

line('');
line(b('══════ 多平台包 → 百度网盘 ══════'));
line(`  目标：百度网盘 /${REMOTE_ROOT}/<产品名>/　共 ${items.length} 个条目`);
line(`  ${dim(DRY ? '【dry-run】只预览，不上传' : '真实上传（同名跳过，不删改）')}`);
line('');

if (!items.length) {
  line(yellow('  没有多平台条目。先跑 npm run fetch:free（会读 assets/free-software/multiplatform.json）'));
  line('');
  process.exit(0);
}

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

const plan = [];

for (const it of items) {
  const byPlat = {};
  for (const f of it.files) (byPlat[f.platform] ||= []).push(f);

  const dir = path.join(STAGE, it.name);
  fs.mkdirSync(dir, { recursive: true });

  const rows = [];
  const names = new Set();

  for (const f of it.files) {
    if (!fs.existsSync(f.local)) {
      line(`  ${red('✗')} ${it.name}: 本地文件不在了（${path.relative(ROOT, f.local)}）`);
      continue;
    }
    const ext = extOf(f.file);
    const lab = LABELS[f.platform] || f.platform;
    // 架构一律写进名字：同平台多包（OBS 的 Apple芯片/Intel）不写就会撞名
    const arch = f.arch ? `(${f.arch})` : '';
    const base = `${it.name} ${verLabel(it.version)} - ${lab}${arch}${ext}`.replace(/\s+/g, ' ').trim();

    if (names.has(base)) line(`  ${yellow('⚠️')} 重名：${it.name}/${base}`);
    names.add(base);

    fs.copyFileSync(f.local, path.join(dir, base));
    rows.push({
      ...f, targetFileName: base, platformCn: lab,
      size: `${(f.bytes / 1048576).toFixed(1)} MB`,
    });
  }

  if (!rows.length) continue;

  fs.writeFileSync(path.join(dir, '使用说明.txt'), readmeMulti(it, rows), 'utf8');

  const total = rows.reduce((s, r) => s + r.bytes, 0);
  line(`  ${green('·')} ${String(it.name).padEnd(18)} ${rows.length} 个包　合计 ${(total / 1048576).toFixed(1)} MB`);
  for (const r of rows) {
    line(dim(`      ${r.targetFileName}　${r.arch || '—'}　${r.size}`));
  }

  plan.push({ id: it.id, name: it.name, remoteDir: `${REMOTE_ROOT}/${it.name}`, localDir: dir, rows });
}

line('');

if (DRY) {
  line(dim('  去掉 --dry 即开始上传到百度网盘。'));
  line('');
  process.exit(0);
}

/* ------------------------------------------------------------------ 上传 */

line(b('──── 上传到百度网盘 ────'));
line(dim(`  用 ${BDPAN}（沙箱：只能写 /apps/bdpan/ 下）`));
line('');

let ok = 0, skip = 0, fail = 0;

for (const p of plan) {
  tryRun(['mkdir', p.remoteDir]);
  const ls = tryRun(['ls', p.remoteDir, '--json']);
  const listing = ls.out || '';

  for (const r of [...p.rows, { targetFileName: '使用说明.txt', local: path.join(p.localDir, '使用说明.txt') }]) {
    const remote = `${p.remoteDir}/${r.targetFileName}`;
    // 幂等：目录里已有同名就跳过（bdpan 没有 fsck 语义，靠 ls 判最稳）
    if (listing.includes(r.targetFileName)) {
      line(`  ${dim('跳过')} ${remote}${dim('（已存在）')}`);
      skip++;
      continue;
    }
    const up = tryRun(['upload', r.local, remote]);
    if (up.err && !/already|exist|已存在/i.test(up.err)) {
      line(`  ${red('✗')} ${remote}　${up.err.slice(0, 90)}`);
      fail++;
      continue;
    }
    line(`  ${green('✅')} ${remote}`);
    ok++;
  }
}

line('');
line(b('汇总'));
line(`  新传 ${green(String(ok))}　跳过 ${dim(String(skip))}　失败 ${red(String(fail))}`);
line(dim(`  核对：bdpan ls "${REMOTE_ROOT}"`));
line('');
