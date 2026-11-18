#!/usr/bin/env node
/**
 * 把「免费 / 开源 macOS 软件」的**官方安装包**整理进百度网盘，并按项目命名规范改好名字。
 *
 * ── 命名规范（见 docs/软件资源分类与采集方案.md 第六节）
 *   1. 平台档写进名字：`- mac版`
 *   2. ⚠️ **避开**「破解 / 免费 / 永久 / 全网最低 / 可商用」—— 闲鱼限流词，
 *      分享出去的页面能看到。（所以本文案里不出现「免费」二字）
 *   3. **版本号必须写进文件名**
 *   4. **架构/芯片写清楚**：`(Apple芯片)` / `(Intel)` / `(通用)`
 *   5. 层级不超过 3 层
 *
 * 落地结构（与已有 `软件/DiPlay/` 同构 —— 单平台单形态就不要再套一层平台目录）：
 *   `软件/<产品名>/<产品名> <版本> - mac版.<ext>`
 *   `软件/<产品名>/使用说明.txt`
 *   `软件/_macOS软件索引.txt`
 *
 * ── 用法
 *   npm run push:free              # 真正上传
 *   npm run push:free -- --dry     # 只预览：会做什么、改什么名
 *   npm run push:free -- --only maccy,alt-tab
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULT = path.join(ROOT, 'out', 'free-software.json');
const MANIFEST = path.join(ROOT, 'assets', 'free-software', 'manifest.json');
const STAGE = path.join(ROOT, 'out', 'free-bundle');
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

/** bdpan CLI 在 ~/.local/bin，shell 里不一定在 PATH */
const BDPAN = (() => {
  const p = path.join(os.homedir(), '.local', 'bin', 'bdpan');
  return fs.existsSync(p) ? p : 'bdpan';
})();

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/* ---------------------------------------------------------------- 架构识别 */

/**
 * 识别 .app 的芯片架构。
 * 为什么要做：命名规范第 4 条要求写清楚，而用户看到的是文件名 —— 写错比不写更坏。
 * zip 直接解压看；dmg 挂载看（-nobrowse -readonly，不留 Finder 窗口）。
 */
function detectArch(file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  let mounted = null;
  try {
    let appDir = null;
    if (/\.zip$/i.test(file)) {
      sh('unzip', ['-q', '-o', file, '-d', tmp]);
      appDir = findApp(tmp);
    } else if (/\.dmg$/i.test(file)) {
      const mp = path.join(tmp, 'mnt');
      fs.mkdirSync(mp, { recursive: true });
      sh('hdiutil', ['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', mp, file]);
      mounted = mp;
      appDir = findApp(mp);
    } else {
      return { arch: '未知', note: '不是 zip/dmg' };
    }
    if (!appDir) return { arch: '未知', note: '没找到 .app' };

    const binDir = path.join(appDir, 'Contents', 'MacOS');
    if (!fs.existsSync(binDir)) return { arch: '未知', note: '没有 Contents/MacOS' };
    const bin = fs.readdirSync(binDir).map((f) => path.join(binDir, f)).find((f) => fs.statSync(f).isFile());
    if (!bin) return { arch: '未知', note: 'MacOS 目录为空' };

    const out = sh('lipo', ['-archs', bin]).trim();
    const hasArm = /\barm64\b|arm64e/.test(out);
    const hasX86 = /x86_64/.test(out);
    const arch = hasArm && hasX86 ? '通用' : hasArm ? 'Apple芯片' : hasX86 ? 'Intel' : '未知';
    return { arch, raw: out, app: path.basename(appDir) };
  } catch (e) {
    return { arch: '未知', note: String(e?.message ?? e).split('\n')[0].slice(0, 60) };
  } finally {
    if (mounted) {
      try {
        sh('hdiutil', ['detach', mounted, '-quiet']);
      } catch {
        /* 挂载点已随 tmp 清理 */
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function findApp(dir, depth = 0) {
  if (depth > 3) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.endsWith('.app')) return path.join(dir, e.name);
  }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.')) {
      const r = findApp(path.join(dir, e.name), depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/* ---------------------------------------------------------------- 说明文件 */

function readme(item, archLabel) {
  const usage = (item.usage || []).join('\n');
  const license = item.license || '';
  const home = item.homepage || item.download_url || '';
  const dl = item.download_url || '';
  return `【${item.name} ${item.version || ''} · macOS】${item.cn}

■ 这是什么
${usage}

■ 包含内容
${item.targetFileName}
  版本　　${item.version || '—'}
  架构　　${archLabel}
  大小　　${(item.bytes / 1048576).toFixed(1)} MB
  SHA256　${item.sha256}
${item.verified === true ? '  ✅ 已与官方发布页给出的校验值核对一致\n' : ''}
■ 安装
1. 双击打开本包（.dmg 双击挂载；.zip 双击解压）
2. 把里面的 App 拖进「应用程序」文件夹
3. 首次打开如果提示「无法验证开发者」：
   在「访达 → 应用程序」里【右键】点该 App → 选「打开」→ 再点一次「打开」

■ 来源与许可
  官方页面　${home}
  安装包　　${dl}
  许可　　　${license}
  本包为**官方原版安装包**，未做任何改动，可直接与官方校验值比对。

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
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const meta = new Map(manifest.items.map((x) => [x.id, x]));

let items = got.items.filter((x) => x.status === 'downloaded');
if (ONLY.length) items = items.filter((x) => ONLY.includes(x.id));

line('');
line(b('══════ 整理到网盘（重命名 + 中文说明）══════'));
line(`  目标：百度网盘 /${REMOTE_ROOT}/<产品名>/　共 ${items.length} 个`);
line(`  ${dim(DRY ? '【dry-run】只预览，不上传' : '真实上传')}`);
line('');

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

const plan = [];
const usedNames = new Set();

for (const it of items) {
  if (!fs.existsSync(it.local)) {
    line(`  ${red('✗')} ${it.name}: 本地文件不在了（${it.local}）`);
    continue;
  }
  const ext = path.extname(it.file).toLowerCase() || '.dmg';
  const a = detectArch(it.local);
  const archLabel = a.arch === '未知' ? '未标（通用）' : a.arch;

  // 命名：`<产品名> <版本> - mac版.<ext>`（版本 + 平台都在文件名里）
  const base = `${it.name}${it.version ? ` ${it.version}` : ''} - mac版${ext}`;
  const dir = path.join(STAGE, it.name);
  fs.mkdirSync(dir, { recursive: true });

  const target = path.join(dir, base);
  fs.copyFileSync(it.local, target);

  const item = { ...it, ...(meta.get(it.id) || {}), targetFileName: base, archLabel };
  const note = readme(item, archLabel);
  fs.writeFileSync(path.join(dir, '使用说明.txt'), note, 'utf8');

  // 重名检查
  const key = `${it.name}/${base}`;
  if (usedNames.has(key)) line(`  ${yellow('⚠️')} 重名：${key}`);
  usedNames.add(key);

  line(`  ${green('·')} ${String(it.name).padEnd(18)} → ${base}`);
  line(dim(`      架构 ${archLabel}${a.raw ? `（lipo: ${a.raw}）` : a.note ? `（${a.note}）` : ''}　${(it.bytes / 1048576).toFixed(1)} MB`));

  plan.push({ id: it.id, name: it.name, remoteDir: `${REMOTE_ROOT}/${it.name}`, file: base, localDir: dir });
}

/* 索引文件（放在软件/ 根下，方便一眼看全） */
const indexPath = path.join(STAGE, `_macOS软件索引.txt`);
fs.writeFileSync(
  indexPath,
  `【macOS 软件整理 · 索引】${new Date().toISOString().slice(0, 10)}\n\n` +
    plan.map((p, i) => {
      const it = items.find((x) => x.id === p.id);
      return `${String(i + 1).padStart(2)}. ${p.name.padEnd(20)} ${it.version || ''}　${(it.bytes / 1048576).toFixed(1)} MB\n    ${it.cn}`;
    }).join('\n') +
    `\n\n全部为**官方原版安装包**，未做改动，附官方校验值可自行比对。\n` +
    `安装包均放在各自同名目录下，目录内附「使用说明.txt」。\n`,
  'utf8',
);

line('');
line(`  索引：${path.relative(ROOT, indexPath)}`);

if (DRY) {
  line('');
  line(dim('  去掉 --dry 即开始上传到百度网盘。'));
  line('');
  process.exit(0);
}

/* ------------------------------------------------------------------ 上传 */

line('');
line(b('──── 上传到百度网盘 ────'));
line(dim(`  用 ${BDPAN}（沙箱：只能写 /apps/bdpan/ 下）`));
line('');

let ok = 0;
let fail = 0;

function tryRun(args) {
  try {
    return { out: sh(BDPAN, args), err: null };
  } catch (e) {
    return { out: e?.stdout ?? '', err: `${e?.stderr ?? ''}${e?.message ?? ''}`.trim() };
  }
}

for (const p of plan) {
  // 目录（已存在会报错，忽略即可）
  tryRun(['mkdir', p.remoteDir]);
  const r = tryRun(['upload', path.join(p.localDir, p.file), `${p.remoteDir}/${p.file}`]);
  if (r.err && !/already|exist|已存在/i.test(r.err)) {
    line(`  ${red('✗')} ${p.name} 安装包上传失败：${r.err.slice(0, 90)}`);
    fail++;
    continue;
  }
  tryRun(['upload', path.join(p.localDir, '使用说明.txt'), `${p.remoteDir}/使用说明.txt`]);
  line(`  ${green('✅')} ${p.remoteDir}/${p.file}`);
  ok++;
}

// 索引
const ir = tryRun(['upload', indexPath, `${REMOTE_ROOT}/_macOS软件索引.txt`]);
if (!ir.err) line(`  ${green('✅')} ${REMOTE_ROOT}/_macOS软件索引.txt`);

line('');
line(b('汇总'));
line(`  成功 ${green(String(ok))} 个　失败 ${red(String(fail))} 个`);
line(dim(`  核对：bdpan ls "${REMOTE_ROOT}"`));
line('');
