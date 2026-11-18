#!/usr/bin/env node
/**
 * 把脚本里写死的家目录换掉（换电脑 / 换用户名 / 迁到 Windows 时用）。
 *
 * 为什么需要单独的脚本，而不是一行 sed
 * ------------------------------------
 * 1. **Windows PowerShell 5.1 的 `Set-Content` 默认写 UTF-16LE**，
 *    `Get-Content -Raw | Set-Content` 这套常见写法会把含中文的 .mjs/.py 悄悄改成乱码
 *    —— 文件还能打开，但中文全变问号，且**不会报任何错**。
 *    这里用 Node 读写，固定 UTF-8 无 BOM，不会碰坏编码。
 * 2. 只改**指定目录里指定后缀**的文件，不会误伤 `drafts/`（758 份商品草稿，中文正文）、
 *    `assets/`（二进制图片/安装包）和 `.workbuddy/memory/`（历史记录，本就该保留旧路径）。
 * 3. 只替换路径字符串，**不动换行符** —— CRLF/LF 原样保留。
 *
 * 用法：
 *   node scripts/_retarget-paths.mjs --to "C:/Users/你的用户名"            # 预演，只打印
 *   node scripts/_retarget-paths.mjs --to "C:/Users/你的用户名" --apply    # 真改
 *   node scripts/_retarget-paths.mjs --to "/home/liu" --from /Users/noonebook --apply
 *
 * 退出码：0 = 正常；1 = 参数错；2 = 预演发现待改项（便于 CI 判断）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXTS = new Set(['.mjs', '.js', '.cjs', '.ts', '.py', '.sh', '.ps1', '.json']);
const SCAN_DIRS = ['scripts', 'packages'];
// 这些目录要么体积巨大，要么内容必须保持原样
const SKIP_DIRS = new Set(['node_modules', '.git', 'drafts', 'assets', 'out', '.cache']);

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const getArg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const FROM = getArg('--from') || '/Users/noonebook';
const TO = getArg('--to');

if (!TO) {
  console.error('用法：node scripts/_retarget-paths.mjs --to "C:/Users/xxx" [--from /Users/noonebook] [--apply]');
  process.exit(1);
}
if (/\\/.test(TO)) {
  console.error(`❌ --to 里不要用反斜杠：${TO}\n   Node / Python / tsx 都吃正斜杠，写 ${TO.replace(/\\/g, '/')} 更安全。`);
  process.exit(1);
}
if (TO.endsWith('/')) {
  console.error(`❌ --to 结尾不要带斜杠：${TO}`);
  process.exit(1);
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(p, out);
    } else if (EXTS.has(path.extname(ent.name))) {
      out.push(p);
    }
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d))).filter(
  // 跳过自己：否则 --from 的默认值和用法注释会被改掉，下次就没法用了
  (f) => path.basename(f) !== '_retarget-paths.mjs',
);
const hits = [];
let total = 0;

for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const n = raw.split(FROM).length - 1;
  if (n === 0) continue;
  total += n;
  hits.push({ file: path.relative(ROOT, f), n });
}

console.log('═══ 路径改写 ═══');
console.log(`项目根：${ROOT}`);
console.log(`替换：${FROM}  →  ${TO}`);
console.log(`模式：${apply ? '✅ 执行（会写文件）' : '🔍 预演（加 --apply 才真改）'}`);
console.log(`扫描：${files.length} 个文件（${SCAN_DIRS.join('/')}，跳过 ${[...SKIP_DIRS].join('/')}）`);
console.log();

if (!hits.length) {
  console.log(`✅ 没有文件包含 ${FROM}，无需修改。`);
  process.exit(0);
}

for (const h of hits) console.log(`  ${String(h.n).padStart(3)} 处  ${h.file}`);
console.log(`\n合计 ${total} 处，涉及 ${hits.length} 个文件。\n`);

if (!apply) {
  console.log('预览结束。确认无误后加 --apply 执行。');
  process.exit(2);
}

let changed = 0;
for (const h of hits) {
  const abs = path.join(ROOT, h.file);
  const raw = fs.readFileSync(abs, 'utf8');
  // 只替换字符串，不动换行符；写回 UTF-8 无 BOM
  fs.writeFileSync(abs, raw.split(FROM).join(TO), 'utf8');
  changed++;
}
console.log(`✅ 已改写 ${changed} 个文件（UTF-8 无 BOM，换行符未改动）。`);

// 复查：确认没有残留，并确认中文没被破坏
let left = 0;
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  if (raw.includes(FROM)) left++;
  if (raw.includes('\uFFFD')) console.log(`  ⚠️ ${path.relative(ROOT, f)} 含替换字符 U+FFFD，请检查编码`);
}
if (left) {
  console.log(`⚠️ 仍有 ${left} 个文件含 ${FROM}`);
  process.exit(2);
}
console.log(`✅ 复查通过：${FROM} 已清除，未发现编码损坏。`);
